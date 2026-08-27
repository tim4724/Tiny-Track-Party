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
| 4 | **does not settle** — 960x540@30 ↔ 640x360@60 | 30 or 56 fps | 12.4 / 15.9 at 360 |

**FOUR PLAYERS NO LONGER HOLDS A RUNG.** The rule reaches 768x432@60 on the way
down, holds a clean 60 with zero skips and a GPU p95 of 12-15 ms there for about
nine seconds, then one second whose p95 touches 18 ms trips `kScaleDownShare`
and it leaves — into the half-rate 960x540@30 entry, from which the exit probe
lands on 640x360@60 rather than back on 432. It then cycles: 540@30 → 360@60 →
540@30. 432@60 is where the box can actually run and is the one rung the rule
never returns to.

That is a change: 432@60 was LOCKED when the sub-floor rungs shipped. The frame
has since grown a per-car contact-shadow stamp and a per-fragment deck shadow,
and at 432 the p95 now sits within a millisecond of the 0.90 share the rule
retreats on — so the rung is no longer held, it is merely passed through.

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
