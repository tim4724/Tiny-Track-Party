# Where an Android TV frame's time goes

A dated measurement record, kept OUT of `shells/androidtv/CLAUDE.md` on purpose:
that file holds rules, and a number in it rots into a phantom regression for
whoever reads it next. What is durable about this session — the method, and the
three traps it walked into — lives there. What is a reading lives here, stamped.

Reproduce with these four. The first says WHERE each player count operates; the
second is the fixed 1080 pin every feature is RANKED on; the last two are the
settled pins that fall out of the first:

```
node scripts/perf-race.mjs  --platform androidtv --players 1|2|4 --vk 1 --pin 0 --seconds 75
node scripts/perf-frame.mjs --players 1,2,4 --track tidepool --pin 1        --vk 1
node scripts/perf-frame.mjs --players 1,2   --track tidepool --pin 0.5      --vk 1
node scripts/perf-frame.mjs --players 4     --track tidepool --pin 0.333333 --vk 1
```

The tool's header is the argument for every other choice below.

## Provenance

| | |
|---|---|
| Date | 2026-08-27 |
| Box | Google TV Streamer, Android 14 / API 34, PowerVR Rogue GE9215, armeabi-v7a |
| Panel | 1080p60 (quote the panel with any number here — 4K is a different frame) |
| Build | release, `1.0-a98da017`, clean — the car contact shadow and the per-fragment deck shadow are IN it |
| Backend | **Vulkan** (`--vk 1`), i.e. what ships. An unflagged `perf-race` arm pins GL and is not comparable |
| Track | tidepool, `bench` scenario (autopiloted player seats at the back of a full grid) |
| Pins | render scale pinned, antialias pass OFF, present rate free (60 Hz panel) |
| Warm | not the first run after an install — that one measures dex/JIT and shader warmup |

## Where the adaptive rule actually operates

Free-running (`--pin 0`), 75 s of race per count. This is the resolution a
player is at, and every "settled" column below is pinned to it.

| Players | Settles at | Presented | GPU p50 / p95 |
|---|---|---|---|
| 1 | 960x540 | 60 fps, 0 skips/s | 9.0 / 10.6 |
| 2 | 960x540 | 60 fps, 0 skips/s | 9.4 / 11.5 |
| 4 | **does not settle** — 960x540@30 ↔ 640x360@60 *(2026-08-27; superseded below: 128 of 150 s at 60 fps on 2026-09-02)* | 30 or 56 fps | 12.4 / 15.9 at 360 |

**FOUR PLAYERS NO LONGER HOLDS A RUNG.** The rule reaches 768x432@60 on the way
down, holds a clean 60 with zero skips and a GPU p95 of 12-15 ms there for about
nine seconds, then one second whose p95 touches 18 ms trips `kScaleDownShare`
and it leaves — into the half-rate 960x540@30 entry, from which the exit probe
lands on 640x360@60 rather than back on 432. It then cycles: 540@30 → 360@60 →
540@30. 432@60 is where the box can actually run and is the one rung the rule
never returns to.

That is a change: 432@60 was LOCKED when the sub-floor rungs shipped, and the
loss has since been BISECTED on the box (2026-08-28). It is a real code
regression, not the box drifting and not the harness: `b8da49cf`, the commit
whose message is "4P is 432@60 now", still reads 60 fps / 0 skips at a pinned
432 today.

| build | pinned 432, two reps | GPU p50 |
|---|---|---|
| `b8da49cf` the lock commit | **60 / 0 skips**, 60 / 0 | 12.86, 12.64 |
| `b2ea2725` skid throttle dropped | **60 / 0**, 60 / 0 | 12.19, 12.66 |
| `0bf4f784` wheel-roll cosmetics | **60 / 0**, 60 / 0 | 12.88, 12.52 |
| `77ee2a82` deck shadow per fragment | 60 / 0, **58 / 1** | 13.24, 13.61 |
| `bafe8fc7` car contact shadow | 57 / 3, 59 / 1 | 15.78, 14.04 |
| `ace8ad0d` HEAD | 56 / 4, 59 / 1 | 15.55, 15.87 |

The two shadow commits are CUMULATIVE — `77ee2a82` costs about 0.8 ms and
leaves the rung marginal (one rep locks, one does not), `bafe8fc7` costs the
rest and breaks it. The Filament v1.75 -> v1.76 bump is NOT implicated:
`bafe8fc7` and HEAD, which straddle it, measure the same.

**AND THE FEATURE BITS DO NOT RECOVER IT.** At HEAD, pinned 432, with
`NO_DECAL_BLOB`, with `~ROAD_SHADOW`, and with both, every arm still reads
58-59 fps and 1-2 skips against the pre-shadow builds' 60 / 0. Turning these two
features OFF does not buy back what landing them cost, so what they added is
not all inside the ablatable path — a bit that gates shading cannot un-bind a
sampler, un-declare a vertex attribute or un-send an upload. **Treat the two
shadow rows of the feature table as a LOWER BOUND on those commits, and never
size a revert from an ablation.**

## The frame, step by step

`sim` → `renderer` (`cars`…`endFrame`) → `slow` → `other` is one Choreographer
callback, in the order it runs them. Milliseconds, p50, at the SETTLED pin for
each count (540 / 540 / 360). It barely moves with resolution — compare the
1080 column of the same run if you doubt it.

| Step | 1P | 2P | 4P | What it is |
|---|---|---|---|---|
| `sim` | 0.4 | 0.4 | 0.4 | `ttp_update`: the sim tick, the event drain, the audio decisions |
| `build` | 0.0 | 0.0 | 0.0 | `buildFrame`: the frame input the renderer is handed |
| `cars` | **1.2** | **1.2** | **1.2** | car poses, wheels, streaks, contact-shadow stamps |
| `world` | 0.1 | 0.1 | 0.1 | deck, terrain, dressing, sky, item and effect pools |
| `skids` | 0.2 | 0.2 | 0.2 | the rubber layer: raster, dirty-rect uploads, mips |
| `beginFrame` | 0.4 | 0.4 | 0.4 | merged-draw transform mirroring, then `Renderer::beginFrame` |
| `cellSetup` | 0.1 | 0.1 | 0.2 | per cell: camera, fog, billboards, the monster swap |
| `cellRender` | 0.6 | 1.0 | 1.6 | per cell: cull and command GENERATION |
| `present` | 0.2 | 0.1 | 0.1 | the antialias pass (off here) and the cell overlay |
| `endFrame` | 0.1 | 0.1 | 0.1 | the commit |
| **renderer** | **2.8** | **3.4** | **3.9** | all of `ttp_display_frame` |
| **callback** | **3.4** | **3.9** | **4.5** | the whole callback; Compose runs AFTER it and is in none of it |

`cars` DOUBLED — 0.6 ms to 1.2 ms — when the per-car contact-shadow stamp
landed, and it is flat across player counts because the stamps are folded once
for the field, not once per cell. `cellRender` is still the only step that
scales with cells. The main thread remains far from the budget either way.

## The threads

CPU milliseconds per PRESENTED frame, off `/proc/<pid>/task/*/stat`, Vulkan.

| Thread | 1P/540 | 2P/540 | 4P/360 | 4P/1080 |
|---|---|---|---|---|
| `FEngine::loop` — Filament's backend, command EXECUTION | 4.5 | 5.4 | 6.5 | 9.5 |
| the app's main thread (the callback above plus Compose) | 4.0 | 4.8 | 5.3 | 9.1 |
| `ttp-mix` — the audio mixer | 0.4 | 0.7 | 1.2 | 2.8 |

The backend thread runs concurrently with the main thread, so it does not add to
the table above — it BOUNDS it. Nothing in-process can see it: not
`ttp_display_profile`, not the readout, not `atrace`'s app markers.

## What each feature costs

MARGINALS — the whole frame minus that arm, GPU p50 in milliseconds. **They do
not sum to the frame**: the content groups occlude each other, so the overlaps
are counted in no row. The deck's four shader CHANNELS are a different quantity
and do sum honestly against the road: the same deck is drawn either way, one
channel shorter, so nothing behind them takes the fill over.

| | 1P/1080 | 1P/540 | 2P/1080 | 2P/540 | 4P/1080 | 4P/360 |
|---|---|---|---|---|---|---|
| **whole frame** | 29.2 | 9.0 | 24.7 | 9.4 | **41.0** | 12.4 |
| floor (every content group off) | 7.8 | 2.3 | 7.4 | 2.2 | 13.1 | 2.0 |
| road | **13.5** | 3.7 | **7.8** | 2.8 | **12.4** | 4.0 |
| terrain | 2.5 | 0.9 | 1.4 | 0.9 | 1.5 | 2.7 |
| dressing | 1.9 | 0.8 | 0.8 | 1.0 | 0.7 | 2.1 |
| sky | 1.3 | 0.1 | -0.3 | -0.1 | 0.5 | 0.2 |
| cars | -0.6 | 0.1 | -0.2 | 0.6 | 0.5 | 2.3 |
| effects | 0.9 | 0.1 | 0.3 | -0.0 | 0.5 | 0.5 |
| **the deck's channels** | | | | | | |
| ↳ decals (the per-fragment loop) | **7.4** | 1.7 | **4.1** | 1.0 | **7.5** | 1.6 |
| ↳ rubber | 3.9 | 0.3 | 1.7 | 0.2 | 3.7 | 0.7 |
| ↳ paint | 1.1 | 0.5 | 0.6 | 0.1 | 1.7 | 0.6 |
| ↳ shadow (the baked sun-vis taps) | 1.0 | 0.1 | -0.0 | 0.0 | 1.1 | 0.5 |
| *(repeat) — the sweep's own resolution* | 0.3 | 0.1 | 0.1 | 0.3 | 0.0 | 0.1 |

The unablated arm was run first AND last, either side of every other arm; the
`(repeat)` row is how far the two disagree. **Nothing narrower than that row is
a result.**

One more caveat, learned the hard way (see the bisect above): an ablation is
only as good as the point it is taken at. The first pass at this regression
ablated at the SETTLED rung, where the box presents on nearly every vsync, and
read GPU p50 — a paced span, where arm differences compress toward nothing. It
returned "both shadows cost 0.4 ms and neither is the cause", and the bisect
then contradicted it. **Ablate at a PINNED point, and judge a rung question on
fps and skips, which say whether the frame met the deadline and cannot be
compressed by pacing.**

Four readings worth stating in words:

- **The road is still the frame, and the DECAL LOOP is over half the road.**
  7.4-7.5 ms at 1080 whether one player or four — it is per-fragment work on
  the deck, and the deck is drawn into every cell. It is the single largest
  addressable channel on this box by a wide margin.
- **The cars are a net NEGATIVE at one and two players**: they occlude more deck
  than they cost to draw. At 4P/360 they read +2.3, which is not fill — it is
  the per-cell submission the next point is about.
- **At the 4P operating point the frame stops being fill-bound.** Going 1080 →
  360 is nine times fewer pixels, and the road's marginal falls only 12.4 → 4.0
  while terrain and dressing RISE (1.5 → 2.7, 0.7 → 2.1). What is left at 360 is
  submission — geometry binned once per cell, four times a frame — which is why
  no rung of resolution rescues four players.
- **Two players is cheaper than one at the same pixel count** (24.7 vs 29.2 at
  1080). Two half-height cells frame less deck each than one full cell does.

## Inside the decal channel: the carShadow TAP is the item, and it is CLOSED

The channel decomposes with the inverted `TTP_DEBUG_NO_DECAL_*` bits, plus one
probe that is not a feature bit: **`debug.ttp.shadow '{"cap":0}'` zeroes
`maskInk.w`, which gates the whole tap block in the deck shader while the CPU
raster and the per-frame layer upload keep running.** That is what splits the
blob's shading from its upload, and it is the reference every row below is
paired against. 4P/1080, Vulkan, tidepool.

| | ms | knob |
|---|---|---|
| decal channel, total | 6.8 | `~ROAD_DECALS` |
| ↳ masked silhouette loop | 0.2 | `NO_DECAL_MASKED` |
| ↳ profile loop (auras) | 2.0 | `NO_DECAL_PROFILE` |
| ↳ statics, inside the profile loop | 1.0 | `NO_DECAL_STATICS` |
| ↳ **carShadow blob** | **6.3** | `NO_DECAL_BLOB` |
| &nbsp;&nbsp;&nbsp;↳ the tap block (shading) | **4.4** | `cap:0` |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↳ of which the bicubic B-spline | 0.55 | `smoothTap:false` |
| &nbsp;&nbsp;&nbsp;↳ CPU raster + upload | 1.9 | `cap:0` minus `NO_DECAL_BLOB` |

**These rows do not sum either, and for a duller reason than the table above.**
Each is its own ablation arm against its own reference, taken in a later sweep
than the feature table, and this one carries a between-build drift of ~1.2 ms
(measured; see the levers below). That is also the whole of the gap between the
7.5 ms this channel prices at in the feature table and the 6.8 ms here. Read the
ORDER of these rows, not their arithmetic.

**The masked loop is DEAD and the cost moved wholesale to the layer that
replaced it.** `kShadowModeBlob` ships at every cell count, `maskCount` is
pinned to 0, and the ablation confirms the loop at 0.2 ms. Any older reading
that attributes this channel to the masked silhouette loop
(`androidtv-4p-plan.md`, Phase 5) describes code that no longer runs. What costs
now is ONE unconditional `texture(carShadow, suv).r` on every deck fragment —
about 3.8 ms once the bicubic is taken out — beside the structurally identical
rubber tap at 3.7 ms.

### Three levers measured dead

Each was paired against its own `cap:0` reference, so the raster/upload half
cancels out of every row.

- **Shrinking the layer: NULL.** `rows` 256 → 64 and `texelsPerU` 16 → 4, and
  both together (a SIXTEENTH of the area), moved the tap 5.61 → 4.93 → 4.78 →
  4.70 ms against a sweep drift of 1.24 ms. The `cap:0` references were flat
  across all four sizes, so the upload half is not size-bound either. **The tap
  is not memory traffic into a big sparse layer.**
- **The bicubic: already paid for.** 0.55 ms, because the four extra fetches sit
  behind a `cs > 0.004` probe gate — the shader comment records +2.1 ms when
  they did not.
- **A per-chunk `shadowBounds` box: NULL.** Built the way `profBounds` and
  `maskBounds` are, from the raster's own rects rather than the decal entries
  (a blob's footprint is projected by `stampSL` under `overscan`, which is not
  the reach `maskRect` carries). It works mechanically — real box on the chunk
  holding cars, empty box everywhere else — and bought 0.60 ms against a
  1.12 ms between-build drift. **Reverted; do not rebuild it** — it was
  rebuilt once more on 12 u chunks (2026-09-03, `blobBounds`), "measured"
  half a millisecond, and the half-millisecond was the shadow not drawing:
  the box went out after the chunk upload's early return. With the write
  ahead of the return it paired null (the 540 section below), and it is gone
  again.

The last one has a mechanism worth keeping: at a 10.5 degree chase pitch the
expensive fragments are the near ones at the bottom of the frame, and those are
exactly where the car — and therefore any box drawn around its shadow — is. A
reject window keeps the costly fragments and drops the cheap distant ones.

That is the same shape as the masked loop's own history, where a depth-EQUAL
stamp pass was built and refuted with "those fragments cost ~7 ms whichever pass
shades them". **Both halves of this channel have now refused every structural
escape tried on them. Price the fragments or delete the channel; do not look for
a seventh pass arrangement.**

### The tap is TWO fetches, and only one of them is collectible in principle

Same-build paired arms (`tap = on - cap:0`), 4P/1080, `smoothTap:false`
throughout so the bicubic is out of both. A probe build hoists ONE
`texture(skidLayer, suv)` and feeds both the rubber and the shadow tap from it —
wrong picture, right instruction count minus one fetch:

| | tap block |
|---|---|
| shipped, two fetches | 5.17 ms |
| probe, one fetch | 3.01 ms |
| **the second fetch** | **~2.2 ms** |

So a fetch on the deck is worth about 2 ms, and the deck takes two at the same
coordinate — `vroad.mat` says the shadow layer is built on the rubber layer's
exact lat span deliberately. One texture serving both would collect it.

**It is not worth building.** One fetch means one texture, which means shared
dimensions AND a shared mip chain: the rubber is 8192x512 with a full chain
refreshed under dirty rects, the shadow is `min(8192, length*16)` x 256, single
level, rewritten every frame. Merging drags a per-frame channel through the
rubber's pyramid at the rubber's higher texel density, trading GPU fill for
frame-thread and upload work — and per the bisect above, fill is not what costs
4P its rung anyway. The 2.2 ms only cashes at 1080 and 4K, where nothing is
currently short.

**The remap is free.** Moving the tail cut out of the shader and into the raster
(`remapInShader:false`, an A/B arm that needs no rebuild) measured 39.26 against
a 39.71 shader-side mean, against a 0.97 ms repeat spread. Null — and it would
have cost 44% more edge flicker. Do not spend on the smoothstep.

### The channel DOES deliver its picture — verified, after a false alarm

The shadow is easy to convince yourself is missing: it sits under and just
behind the car at a 10.5 degree chase pitch, it is soft, and it darkens a deck
that is already grey. Two arms settle it, and both are cheap to repeat:

- **Measured.** Over the deck band under the player car, the 5th-percentile
  luminance goes 108 (`NO_DECAL_BLOB`) -> 79 (shipped); the median goes
  121 -> 115.
- **Seen directly.** A temporary `base = vec3(cs)` / `vec3(min(a, csw))` in the
  tap block paints the sampled coverage and the composited alpha onto the deck.
  Both come back bright on VISIBLE deck behind the car, so the tap reads the
  stamp and the remap passes it through.

Worth writing down because the eye is the wrong instrument here and three
separate checks were run on the strength of it. **Do not conclude this channel
is broken from a screenshot** — measure the band, or paint the coverage.

The stamp is also the CAR'S OWN FOOTPRINT and no larger, so most of it is
occluded by the car from a chase camera by construction. `grow` (0..1, dilate in
footprint half-widths) is what makes it obvious in a debug capture; the shipped
0 is not a bug.

## EVERY SETTLED COLUMN IS A PACED SPAN, and this is why the sweep runs twice

At the rung each player count settles on, the box presents on essentially every
vsync (59.5 / 59.5 / 55.9 fps). The GPU then idles between frames, downclocks
into the gap, and this backend's timer reads the PACED span rather than the
work: the absolute numbers come back inflated and the differences between arms
come back COMPRESSED. `perf-frame.mjs` names any column this applies to rather
than leaving it to be noticed, and it named all three.

So the settled columns are the operating point, not the price list. **Rank the
features on the 1080 columns**, where the same picture saturates; read a settled
column only for shape — which is where the 4P submission finding above came
from, because it survives the compression by pointing the wrong way.

The two escapes that would saturate a settled column both change the question:
pinning below the rung measures a picture nobody plays, and `--hz 30` doubles
the budget the readout scores against. Neither is worth a third sweep.

## The CPU side under VULKAN, and the framebuffer-eviction fix (2026-08-24)

The thread table above is post-fix. What the fix was, and why the backend
thread used to cost 9.32 ms per frame at 4P instead of 7.0:

**What the 9.32 was, from simpleperf** (the release APK is `<profileable
android:shell>` now, so `simpleperf record --app` works on the retail box;
symbolize against the unstripped `.so` with `binary_cache_builder.py -lib`):
30% of the backend thread was `ioctl` into the PowerVR KMD, and a whole
cluster — `~VulkanFramebuffer` 7.4%, `VulkanFboCache::getFramebuffer` 1.4%,
`ResourceManager::gc` 8.2%, `RGXAddRenderTarget` 9.3% (the ICD rebuilding its
kernel render-target dataset at every `vkCmdEndRenderPass`) — was ONE defect:
**Filament's default `timeBeforeEvictionFbo` is 3 frames, and a
triple-buffered swapchain reuses each image's framebuffers every third frame**,
so the cache sat exactly on the eviction edge and every acquire-order jitter
(ordinary at 4P, where frames skip) recreated the lot. `TtpRenderer::init`
now provides a `VulkanPlatformAndroid` subclass whose Customization raises the
age to 60 — no fork patch, just the virtual `getCustomization`. After it, none
of those symbols register in the profile, total ioctl reads ~21%, and the GPU
arm is unchanged (15.79 p50 at 4P/540 against the 15.68-15.9 band).

**What remains in the 7.0 and what it is:** one big `vkQueueSubmit` at present
(~24% — the per-submit kernel cost on this ICD, not a count problem), the
draws' descriptor/pipeline-cache walk, our texture uploads (`update3DImage`
~6%: the carShadow ping-pong and the skid layer), and allocator noise. Nothing
left is a single fault.

**The GL backend is not worth patching, measured:** its backend thread is 36%
inside `libGLESv2_powervr.so` and 31% kernel, with under 5% in Filament — the
driver itself is the cost, which is the Vulkan default's whole justification,
now with stacks under it.

## The 4P frame is TWO frames, and the far deck is the one that costs (2026-09-02)

Same box, same build lineage (`1.0-ae7e22ba`), Vulkan, tidepool, 4P pinned
768x432. Read the readouts PER SECOND instead of folding the run, and the "tail"
every table above describes turns out to be a periodic picture: about nine
seconds a lap at GPU p50 ~11.5 ms, clean 60, zero skips — then about eight
seconds at 20-21 ms, 40-50 fps, 10-20 skips/s. The expensive stretch is every
cell looking down the start straight at the whole deck receding to the horizon
(the host counter puts that frame at 590k indices against 330k, 238k of them the
deck's). It recurs every ~17 s because that is the bench lap.
`perf-race --timeline` prints this split now; a whole-race median cannot see it.

**Only the expensive seconds are honest numbers.** The quiet seconds hold 60, so
the GPU downclocks into the gap and their p50 is a PACED span: every ablation
delta taken from them came back compressed two to three times. Rank on the
heavy seconds and nothing else.

**The fix is the deck's FAR RIBBON** (`RoadChunk`, `chooseDeckLod`): a second
index buffer over the road's own vertices in which each strip draws a run of
same-coloured rings as one quad, chord error capped at 0.08 u, and each chunk
swapped onto it per cell where that chord is under a pixel for the cell's size
(two pixels since — the arms are at the end of this section). Interleaved on
ONE install, the bit verified on the device log:

| arm | quiet 30% | vista 30% | clean seconds of 40 |
|---|---|---|---|
| far ribbon (near ≈ 17 u at 216 lines) | 10.94 / 10.95 | **15.40 / 15.84** | 33 / 32 |
| fine ribbon everywhere (`0x100DFFC`) | 11.86 | **20.95** | 19 |

Five milliseconds of a 16.7 budget on the stretch that decided the rung, for a
picture that is pixel-flat at 1280x720 on the host (the far kerb bands, dashes
and edge lines are the fine ribbon's own vertices, so they do not smear). An
adaptive 4P race on the same build ran 60 fps / 0 skips typical and climbed
480 → 540 → (a vista dip to 360) → 432 → 540 over its first ninety seconds,
where the ledger above recorded it cycling 540@30 ↔ 360@60.

**THE RULE THEN SPENT HALF THE RACE AT 30 FPS BY ITS OWN CHOICE**, read per
second over 150 s of adaptive racing on the far-ribbon build: 480@60 for 10 s,
then the half-rate 540 entry for 28 s, 360@60 for 30 s, 432@60 for 9 s, the
half-rate entry for 27 s again — 54 of 150 s at 30 fps while every full-rate
rung it left had just measured 58-60 fps. Two things in `render_scale.h` did
that. A retreat with a fit went straight past the split's rungs to the
half-rate entry, because a p95 fit on a vsync-quantised device reads 432 and
360 as late; the backstop is now entered from the bottom rung only. And the
entry's exit probe waited out the lap-sized up-hold, so one late second bought
28 s at 30 fps; it probes on its own 8 s hold now (`kScaleEscapeProbeSec`).
The same race afterwards:

| operating point | seconds of 150 | mean fps | skips/s |
|---|---|---|---|
| 640x360 @60 | 100 | 59.7 | 0.3 |
| 768x432 @60 | 28 | 60.0 | 0.0 |
| 853x480 @60 | 10 | 59.0 | 1.0 |
| 960x540 at half rate | 8 | 30.3 | 0.1 |

Both rules are pinned in `render_scale_check` (the retreat from a mid rung
lands on the bottom one, the retreat from the bottom rung still reaches the
backstop, the probe fires on its own hold and not before). What the box still
does: it takes the far ribbon's 432 only after a 28 s climb hold at 360, and a
genuinely late vista second at 360 (16.5 ms, 3-6 skips) still dips it to the
backstop for 8 s.

**The chunk length is the ribbon's real near gate.** A chunk swaps whole and
the chunk the camera is in is always near, so at 78 rings (37 u) the far
ribbon could not start before the next boundary, 40-70 u ahead, whatever the
distance gate said — which is why every nearer gate measured null. Cutting
chunks at 26 rings (~12 u) takes the heavy seconds from 15.4-15.8 to
14.2-14.5 ms; 13 rings reads 14.7 and adds 0.7 ms of frame thread (each chunk
is a renderable and a decal fold). Shipped at 26; while the trade was being
judged the ribbon was painted magenta (now `TTP_DEBUG_DECK_LOD_TINT`,
0x400DFFC): 14.9 ms and 36 clean seconds of 40 with the tint on.

**The gate's whole remaining value is 1.2 ms**, measured by drawing the whole
deck on the ribbon (interleaved, pinned 432, two reps: heavy seconds 15.01 /
14.84 → 13.56 / 13.91 ms, paced 10.6 → 9.6, clean seconds unchanged). That
shipped briefly and was taken back for a threshold, which now applies at
every cell count, one player included. The threshold then went to a
TWO-pixel chord (`kDeckLodChordPx`, the gate halved: ~8 u in a 4P cell on the
box): 14.63 / 14.65 ms on the heavy seconds, 34 clean seconds of 40 — a third
of the way from the one-pixel gate to no gate.

**What the far deck is NOT, priced at the same point:** its lateral slivers
(a 6-strip far cross-section measured the same as the ring runs alone — the
strips stay), a second, coarser level past 60 u (0.3 u chords, 48-ring spans:
15.39/15.67 with, 15.26/15.48 without), a nearer gate (the chord bound at two
pixels, ~8 u: 15.35), the rubber tap's anisotropy (0), the shadow layer's size
(0), merged vs unmerged groups (0.15), the road material minus its dead masked
block (≤ 0.5, inside a cross-install bracket), the Compose HUD window (0), and
static dressing culled past 100 u (0.2 — the dressing's 3.8 ms is all inside
the fog's near edge). **Moving the kit's and the lit sheets' matte light to the
vertex stage is a LOSS** (16.05/16.63 against 15.4-15.8): at four cells the
frame is vertex-bound, and the fragment work that trade removes is smaller than
the vertex work it adds. **Baking the sheets' light INTO their vertex
colours is a WIN** (`Mesh::bakeLight`, later the same day) — it removes the
vertex work rather than moving it: heavy seconds 14.63 / 14.65 → 14.08 /
13.88 ms, paced 10.3 → 9.8, two reps each, pinned 432. The kit COPIES then
went the same way through their merged groups (`MergedGroup::baked`: the
instances expanded into one mesh, texture colour from `generated/kit_colors.h`
x the live factor x light per vertex): 14.08 / 13.88 → 13.52 / 13.88, a third
of a millisecond, pixel-identical to the live draw. Every static thing in the
scene is now lit at build; what still lights live is the cars, the cone pool,
the windmill, the plane, the rockets and the shadow receivers.

**THE COST MODEL RE-FITTED ON THIS BUILD (4P, heavy seconds, pinned).** The
old "2.6 ms per cell, resolution-independent" was vertex and binning work
that the ribbon and the bakes have since cut, NOT pass structure: an EMPTY
scene (a mask naming no group, `0x2` — a mask of 0 is untagged and draws
everything) costs 2.5 ms at 4P and 1.6 at 1P, so an extra cell's passes,
clears and overlay are ~0.3 ms. Everything else is inside the groups, each
drawn alone at 432 and at 216 lines (above the empty scene):

| group | alone at 432 | alone at 216 | reading |
|---|---|---|---|
| terrain | 3.8 | 0.7 | fill |
| road | 3.1 | 0.7 | mostly fill |
| dressing | 2.5 | 1.2 | half fixed, half fill |
| cars | 2.0 | — | mostly fixed |
| sky | 0.1 | — | nothing |

Full scene at 432: 13.6; the sweep 10.5 / 13.6 / 21.1 ms at 216 / 432 / 648
lines. So the 4P frame is FILL now, the sand first. Drawing the ground and
hills AFTER every other opaque (priority 5) to let the depth test reject the
sand under the road measured a null (13.67 / 13.37 against 13.60 / 13.65) —
the tiler already kills that overdraw. The grade LUT is 0.4 ms of the frame
(`0x9FFC`, two reps: 14.10 / 14.00 → 13.62 / 13.66) and cannot be made
cheaper in arithmetic; only an sRGB surface recovers it.

**Three more arms after the bakes, all nulls (4P pinned 432, heavy
seconds, baseline 13.4-13.9 across the day):**

- **An sRGB swapchain instead of the grade LUT.** Filament grants the flag
  on this box's Vulkan (the renderer logged it), the picture is right, and
  the frame does not move: 13.75 / 13.85. The store-side encode costs what
  the three taps cost on this GPU. The change is parked as a patch; its one
  open question is the Apple TV at 4K, where fragments dominate, and that
  run is blocked until Xcode can sign a device build again.
- **The kit material unshaded** (a temporary arm, base colour only, no
  normal): 12.75 / 13.12 — the ceiling of what lighting the cars and cones
  cheaper could buy, ~0.5 ms.
- **The kit material lit per vertex**, the real way to spend that ceiling:
  13.52 / 13.88. The vertex light costs what the fragment shade saved, even
  with only the cars and the cone pool left on the material. Pixel-identical
  otherwise (flat-shaded kit), so nothing to trade against.

**INPUT LATENCY ON THE BOX IS THE PLATFORM'S PIPELINE, NOT OUR QUEUE**
(2026-09-02, SurfaceFlinger `--latency` on the app's BLAST layer). A finished
frame waits ~49 ms (p50; p90 51) from its acquire fence to the panel at 60,
~41 at the pinned 30, with a clean 16.7 ms cadence and zero skips. The
swapchain is not why: a scratch Filament (session history) added flags for
the surface's MINIMUM image count and MAILBOX presentation, the box's driver
granted both (`Swapchain: 4 images (min 4), present mode MAILBOX` — the
surface's minimum is FOUR), and all four arms read the same 48-49 ms. The
number is the box's frame timeline: `dumpsys SurfaceFlinger` shows app phase
+13.7 ms, app work duration 20 ms, SF ready duration 33 ms — the app is
handed the vsync 3 ms before the next one and SurfaceFlinger takes two more
to show what it queues. Nothing in the swapchain, the present mode or the
image count reaches that. The frame timeline API was then PROBED and is
dead too (`Choreographer.postVsyncCallback`, the offered slots logged): per
vsync SurfaceFlinger offers presents at +36, +53 (preferred), +70 ms ...,
each with a queue-and-fence deadline 33 ms before it. The app's callback
lands at +13.7 and its GPU work is done near +28, so the +53 slot's +20
deadline is missed on every real frame and the +70 slot is what the 49 ms
is. Making +53 needs the GPU finished within ~6 ms of the callback; a
self-timed loop starting the frame at the vsync would make it, but samples
input that much earlier — a net ~5 ms for a drift-prone loop. Not built.

## 540 at four players: the deck layers' UPLOAD EVENTS (2026-09-03)

The next rung up. Same bench, pinned 960x540, heavy seconds, the far-ribbon +
bakes build as the base: **17.35-17.5 ms, 26 clean seconds of 40**, so 540
missed 60 by about a millisecond on the vista. Every arm below is that base
minus the feature, tidepool unless named:

| arm | heavy p50 | reading |
|---|---|---|
| decal channel off | 15.1 | -2.2 — and `NO_DECAL_BLOB` alone is 15.12: the whole channel is the car-shadow blob |
| profile loop / statics / caps-half | 17.2 / 17.4 / 17.6 | -0.3 / 0 / 0 |
| rubber layer off | 15.9 | -1.4 |
| paint, grade, road shadow, fog in the vertex stage | ≤ -0.3 | nothing |
| shadow tap knobs: bicubic off, 8 texels/u + 128 rows, both | 17.55 / 17.51 / 17.05 | null |
| isotropic sand / rubber filters | 17.46 / 17.44 | null |

The other cups at the same point: powder 21.8 (2 clean of 39), ribbon 20.0
(14), wash 18.3 (21); the playroom tracks (skyline, gauntlet) 9.9 with 40 of
40 — the cheapest scenes in the game, not the dearest.

**The blob channel's 2.4 ms was one thing, and it was not the tap's
arithmetic.** A per-chunk box round the stamps (`blobBounds`, the 1080-era
`shadowBounds` rebuilt on 12 u chunks) went in first and read 16.92 at 540,
13.16 at 432, "byte-identical frozen frames" — and was a NULL wearing a
bug: its box was written after the chunk upload's decal-list early return,
so a chunk nothing dynamic crossed kept an empty box and drew no shadow, and
the frozen frame that passed it had the car on a boost disc whose aura
composites over the blob. Written before the return, the gate paired
tidepool 14.91 / 15.63 against 15.05 / 14.91 and glacier 21.59 / 21.73
against 21.46 / 21.63 with no gate (2026-09-04). Removed; the 1080-era
verdict stands. **Verify a car-shadow change on a frame where the shadow is
VISIBLE** (frame 2400 of the 1P tidepool bake, a clear road) **and against
the pre-change artifacts**, never on frame 900.

What the channel actually pays is **THE UPLOADS — AND THE COST IS PER COPY,
NOT PER BYTE.**
Probe keys that skipped each layer's `setImage` calls (rasters, taps and binds
all still running; session history) read: shadow uploads skipped 16.31,
rubber uploads skipped 15.24, both 15.39 — a few kilobytes a frame worth
1.7 ms. Four mechanisms were then built and refuted in turn, each on the
device:

- **the barrier's stage masks** — a scratch Filament that transitions a
  sampled texture for its copy without waiting on prior fragment reads
  (`srcStage TOP_OF_PIPE`): 17.13 / 17.23, null;
- **an in-flight reader** — the rubber copies routed into a twin texture
  that nothing ever samples: 16.90 / 16.81, null;
- **the texture's shape** — twins with one level, with the chain but no
  mip-generation usage, with half the rows: 16.67 / 16.44 / 16.30, null;
- **the count** — counted on the device log, a 4P frame issued 400-870
  rubber copies and 300-490 shadow copies per 60 frames (21-139 KB/s of
  rubber); every rubber rect of a frame sent as ONE copy, a hundred times the
  bytes (bursts to 40 MB/s): 16.12 / 15.55.

So each `setImage` is its own kick on this driver, and the cure is fewer of
them: both layers now merge a frame's rects by arclength under a byte budget
(`kUploadEventTexels`, TtpRendererDecals.cpp — a pack shares a copy, a lone
car keeps its own) and the rubber's mip refresh merges per level the same
way. **540 with the gate and the merge: 15.43 / 15.88 ms, 35 / 32 clean
seconds of 40; 432: 12.67, 37 of 40; powder at 540: 20.41 (16 of 40, from
2).** The beach vista holds 60 at 540 now; the powder- and ribbon-class cups
are still three to four milliseconds over it there, and their overage is
fill (terrain and deck), not anything a copy count reaches.

The Android shell notes recorded the rubber layer's event rate as a null
under a 20 ms 720-line frame in August; that verdict does not transfer to
this frame, and it is amended there.

**A rubber-tap gate in the same per-chunk-box shape is a NULL too (2026-09-04):** a
per-chunk u span from the raster's own ink bins, the tap skipped where the
lap is blank. Same-session pairs: tidepool 15.55 → 15.63, ribbon 18.11 →
18.60, powder 18.74 → 20.3-20.5 (powder itself repeats 18.7-20.4 across
runs on ONE build — it is the noisiest track of the twenty, pair on ribbon
or tidepool instead). Once eight cars have scrubbed the corners, ink sits
within the tap's footprint margin of nearly every chunk, so the gate
rejects almost nothing. Not shipped; session history has the patch.

**EVERY TRACK at 540, four players (2026-09-04, the merge build → the
build with the spread refresh and the folded overlay, same day):**

| cup | tracks | heavy p50 | clean s of 40 |
|---|---|---|---|
| beach | tidepool, cove, driftwood, riptide | 14.5-16.8 → 13.7-16.1 | 28-33 → 28-33 |
| snow | powder, flurry, glacier, avalanche | 18.9-20.1 → 19.5-21.0 | 11-21 → 7-18 |
| lawn | ribbon, pretzel, tangle, cloverleaf | 18.1-19.3 → 17.5-18.8 | 18-23 → 17-25 |
| redrock | wash, gulch, crag, sidewinder | 16.0-17.7 → 15.0-16.7 | 23-28 → 27-32 |
| playroom | skysnake, skyline, helix, gauntlet | 9.6 | 40 |

(Snow's spread across runs is a millisecond on one build; read its two
columns as the same picture.)

**The heightfield relief is NOT a cost either (2026-09-04).** Powder with
its amplitude zeroed read 18.96 against 20.43 in one session, which looked
like 1.5 ms of hills; a far-only flatten (full height to 30 u past the road
edge, flat by 70 u) then paired null on the stable tracks — ribbon
18.15 / 18.11 → 18.07 / 18.17, glacier 21.62 / 21.65 → 21.83 / 21.49 — and
the 1.5 was powder's own spread. The snow cup's overage over the beach is
its flat sheet and its dressing, not its hills. Reverted.

**THE VISTA IS GEOMETRY, THE QUIET SECONDS ARE FILL (2026-09-04).** Read
per second, tidepool's quiet seconds sit at 11.5-13 ms and its three vista
seconds at 17-21, with the SAME pixel count — so the vista's extra is what
comes into view, four cells over, not fill. Priced on those three seconds
alone (`vista3`, the mean of a run's three dearest seconds; this metric
repeats within ±0.7, so pair two reps): road hidden −5.0, dressing hidden
−3.3, terrain hidden −2.7, cars −0.7; the fine ribbon everywhere +4. The
road's per-pixel channels are null there (rubber, decals, paint, sun-vis
each within the band), and the geometry is SMALL — the whole fine deck is
26k triangles, the far ribbon 6k, the merged dressing 3-8k (a device-log
probe, session history) — so what the road pays on the vista is not its
shading and not its vertex count. Half the dressing copies is null; the
one-renderable SHEETS read 2.3 on tidepool and 0 on glacier, one rep each.

Two more structural arms on the vista, both NULL and reverted: the deck at
13 and 52 rings a chunk (draw count halved or doubled: 16.0 / 17.3 and
17.3 / 18.3 against 17.0 / 17.0 — draws are not the road's vista cost), and
the static sheets (hills, ground, boulders, landmarks, structures, berms)
uploaded as 2000-triangle range chunks so a cell can frustum-cull them
(tidepool 15.47 / 15.51 against 15.39 / 15.37, glacier 21.63 / 21.11 against
21.29 / 21.34, vista unchanged). What the vista's road and dressing pay is
therefore neither their draws, nor their vertices, nor their channels, and
the one instrument that could split it further is a GPU profiler this box
does not offer.

**THE OVERLAY PASS WAS 1.2 ms, AND IT IS FOLDED INTO THE CELLS (2026-09-04).**
The renderer's 2D chrome (dividers, steer bars: `voverlay.mat`) was its own
View rendered after the cells — a load and a store of the whole canvas for a
handful of rounded rects. Skipping it read tidepool 14.08 / 14.37 against
15.63 / 15.15 on the heavy seconds (vista 15.0 / 16.0 against 17.7 / 16.7).
The material is device-domain now: its vertex stage maps the quad's canvas
pixels into the drawing view's cell from a view global, so on a platform
with no present pass the same quads draw inside each cell's own pass and the
overlay view does not render; with the antialias pass (the web), or the
ribbon tint owning the globals, they stay in the overlay view as before.
Same pixels on the box's own screenshots; folded: tidepool 14.53 / 14.93,
vista 16.0 / 16.3; glacier 21.45 / 21.12 against 21.84 / 21.39. One fix
followed on a Pixel 7: the vertex stage read `getWorldFromModelMatrix()`,
which is in Filament's render world, rebased at each view's camera every
frame, so the chrome drifted with the camera — a divider a hundred pixels
off and wandering on the phone, and right on the box only by the moment of
its shot. `getUserWorldFromWorldMatrix()` undoes the rebasing; the rules
now sit on the cell boundaries on both devices.

Two tail sources besides the vista showed on the same timelines and one is
fixed: the rubber mip refresh landed every level's copies in one frame
twice a second (p50 13.4, p95 17.4, three skips in an otherwise quiet
second) and now lands ONE level per frame (`refreshSkidMips`), 28 / 31 → 31 /
34 clean seconds; the launch second skips 7 every run with a clean GPU
median, and the device log says why: the bench's scale pin is applied
after the scene build, so the surface RESIZES (`setFixedSize`) inside the
first race second. A bench artifact, not a race-frame cost — a track can
read 39 of 40 at best on this harness.

**THE VULKAN RENDER AREA IS A NULL HERE, AND A PATCH FOR IT SHIPPED FOR AN
HOUR AS A BLACK PICTURE (2026-09-04).** Filament's Vulkan backend opens
every view's render pass with the render area set to the whole attachment
(`VulkanDriver::beginRenderPass`), so four cells sharing one swapchain
image nominally load and store its colour four times over. A fork patch
constraining the area to the pass viewport paired tidepool 14.89 / 15.32 →
14.81 / 14.23 and was pinned as ttp-1.76.1 — and the box's screen capture
showed the race chrome over BLACK: the patch flipped the viewport to
top-left itself and `transformClientRectToPlatform` flipped it again, so
each cell's area was the mirrored quadrant, its draws fell outside it, and
the store covered a region nothing drew into. The bench could not see that,
because the GPU still drew every frame; the "win" was the broken store.
Reverted (af78978a). The corrected patch (client rect handed unflipped,
constrained only when no colour attachment is cleared and depth/stencil is
discarded on entry, in-pass scissors clamped to the area) renders every
cell and pairs NULL: tidepool 14.84 / 15.22 against 14.93 / 14.57, glacier
21.50 / 21.56 against 21.48 / 21.68. This GPU only touches the tiles a draw
reaches, so the render area buys nothing on it; the branch is kept in the
fork's scratch checkout for a device that shows otherwise. **Two rules from
it: a Vulkan-backend change is verified by a screen capture on the box, and
client rects go to `transformClientRectToPlatform` in GL bottom-left form.**

Note what "clean" says: a heavy p50 under the budget is not a held 60 —
tidepool at 15.7 still skips in a quarter of its seconds, because the p95
of the vista is what the panel sees. A track holds 540 when its vista p50
is around 14 (the playroom's 9.6 is 40 of 40). By that standard the
outdoor cups are two (beach) to six (snow) milliseconds short, and the
group ablations put that in the terrain (relief 1.5 on snow, the sheet
2.0), the dressing (1-2) and the road (3.4-4), every one of them fill.

What remains is per-fragment: the two deck taps at
~1.5 ms each on the heavy seconds, the copies 1.3, the sheets 2.5 (they are lit
`vlitns`, not free), cars 2.3.

**Three method traps, each of which cost hours here:**

- **A seven-digit mask.** `TTP_FEAT_ALL | 0x1000000` is `0x100DFFC`; `0x10DFFC`
  sets bit 20 (`DECAL_CAPS_HALF`) and leaves the new bit clear. Every "off" arm
  of the first pass was on, every within-build A/B of a bit above 0x800000 read
  null by construction, and the real signal sat in the cross-build numbers
  being written off as noise. **Log the state the bit gates from the renderer
  and read it off the device before believing an A/B** — one `slog.i` line a
  second found this in one arm.
- **The absolute level moves with the BUILD, not the install.** Reinstalling one
  APK reproduces its vista to ±0.2 ms; two builds that differ only in a
  supposedly-inert path do not. There is no "install plateau" to correct for.
- **A backgrounded `adb logcat | grep > file` outlives its arm** and keeps
  appending, so a file re-read later carries later arms under later pids, and a
  caller piping the sweep's output waits forever on the pipe the orphan still
  holds. Capture with a plain child, kill it by PID, filter afterwards.
