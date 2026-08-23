# Getting four-player split to 60 fps on the Android box

The goal, and the only one this plan serves: **four cells at 60 fps, at the
highest resolution rung the box will hold.** Not a rate escape, not a 30 Hz
mode. It is reached iteratively — every phase below either buys milliseconds,
which convert into lines, or buys certainty about a number that is currently
contradictory.

A plan is not a rule, so this lives here rather than in
`shells/androidtv/CLAUDE.md`, next to `androidtv-frame-map.md` and for the same
reason: what is durable about the METHOD is in that file, what is a reading or a
forecast is here, stamped and datable.

## The arithmetic that makes this a plan and not a wish

On this box the frame is `fixed + fill * s^2`, where `s` is lines/1080 and the
fixed half is what no render scale reaches under.

**Fitted 2026-08-23** on the connected Google TV Streamer (kirkwood, Android 14),
build `1.0-d4d85430`, Vulkan, tidepool, `--pin` interleaved x3 at 1.0 and 0.5:

    4 cells   fixed  8.10 ms     fill 31.17 ms at 1080
    1 cell    fixed  2.93 ms     fill 26.37 ms at 1080

That is the 2026-08-22 fit again (10.25 / 30.8, less the ~1.5 ms the
staging-buffer bypass took off the fixed half) — **nothing regressed, and the
model is confirmed rather than assumed.** The per-cell term falls out of the two
rows: **1.72 ms of fixed cost per cell**, over a 1.21 ms base.

Rearranged, that is a milestone ladder. A rung holds 60 when
`fixed + fill * s^2 <= 16.7`:

| rung | s | measured p50 | measured p95 | holds 60? |
|---|---|---|---|---|
| 960x540 | 0.500 | 15.9 | 24.6 | median yes, **tail no** |
| 1280x720 | 0.667 | 22.0 (model) | 33.0 (model) | no |
| 1920x1080 | 1.000 | 39.3 | 57.1 | out of reach on this GPU |

Break-even is **567 lines**, so 540 sits 27 lines under the wire with no margin.

- **540 at 60 is a TAIL problem, not a median problem.** The median already
  fits and has for a while. What misses is 8-11 frames a second.
- **720 at 60 needs about 5.3 ms off the frame**, and it cannot come from the
  fixed half alone — the fill has to come down with it.

Milliseconds convert to lines at `lines = 1080 * sqrt((16.7 - fixed) / fill)`.
**Every millisecond off the fixed half is worth roughly 30 lines**; a
millisecond off the fill at 1080 is worth about 9. That is the exchange rate to
quote when deciding whether a lever is worth its look.

## Phase 0 — RESULTS (2026-08-23). Settled; no code changed.

Every arm below is Vulkan-pinned, scale-pinned, tidepool, 45 s counted after the
grid, on the box named above.

**The 6 ms contradiction was an instrument fault, not a regression.** The two
campaigns disagreed because one of them was a GL arm:

| arm | reading | says |
|---|---|---|
| 0.1 4P/540, `--vk 1`, pinned, x3 | **15.9 p50 / 24.6 p95**, 49-52 fps | today's truth |
| 0.3 4P/540, pinned, `--vk` OMITTED | **26.8 p50**, 33 fps | GL costs **+10.9 ms** at four cells |
| 0.3 4P, `--vk 1`, NOT pinned | 15.1 p50, **0 skips, 30 fps** | the 30 Hz escape, measuring a downclocked GPU |

The 08-23 figure of 23.5 ms was an unflagged (GL) arm. `perf-race` pins GL on
purpose when `--vk` is absent, and that alone is the whole discrepancy.

**0.7 is answered without a revert build.** The skybox was the one unmeasured
change between the campaigns, and the fill half it would have inflated came back
at 31.17 against the pre-skybox 30.8 — inside pairwise noise. The whole sky
group's marginal is 0.8 ms at four cells besides, so there is no room in it for
a multi-millisecond regression. Not A/B'd directly; not worth a build.

**Gate: the work is TAIL work.** 0.6 came back near 16, not near 23, so the
claim that the 4P floor is ~19 ms is retired.

### 0.4 — the frame map, at `--pin 1.0`

The backend thread is the largest CPU consumer and is not the bound: at four
cells `FEngine::loop` costs 11.4 ms of CPU per presented frame against a 38.8 ms
GPU frame. The main-thread callback is 4.0 ms p50 / 5.1 p95, of which
`cellRender` is 1.5 — culling and command generation, not execution.

**The floor is the finding.** An EMPTY four-cell 1080 frame — every content
group off, only the cells, the passes and the present — costs **12.0 ms**, and
holds 60 fps. At one cell it is 7.4. That is 31% of a full frame spent before
anything is drawn, and it is the ceiling on everything Phase 1 can buy.

### 0.5 — the marginals, re-attributed POST-bypass

Bracketed by a repeated baseline at both ends, which is what sets the resolution
column. **Anything narrower than the bracket is not a result.**

| group | 1 cell | 4 cells | |
|---|---|---|---|
| bracket resolution | 0.8 | 1.4 | |
| road | **15.3** | **15.0** | the deck IS the frame, and it is cell-count-independent |
| terrain | 0.7 | **2.1** | |
| dressing | 0.6 | 1.1 | below the bracket at four cells |
| sky | 0.2 | 0.8 | below the bracket. The 2.15 the bypass was going to be tested against is GONE |
| cars | **-2.7** | -1.3 | cars occlude deck fragments; hiding them costs |
| effects | -0.4 | -0.4 | |

The road dominates and does not care how many cells it is split into, so it is
pure fill. A second sweep took it apart, at four cells and `--pin 1.0`, with a
0.15 ms bracket:

| road channel | marginal at 1080 | at 540 | |
|---|---|---|---|
| **the per-fragment decal loop** | **+6.45** | **+1.61** | **the single largest lever on this board** |
| laid rubber | +0.93 | +0.23 | zero within noise |
| deck paint | -0.79 | -0.20 | zero within noise |
| ground sun-vis tap | -1.24 | -0.31 | zero within noise (see below) |
| fog's FRAGMENT mix | -1.11 | -0.28 | zero within noise |

Three channels reading -0.8 to -1.2 is not evidence that dropping work makes
the frame slower. The bracket was 0.15 ms, so sweep-long DRIFT is ruled out —
but a bracket only rules out drift, not each arm's own variance, and 1080
pairwise noise is +-1.2 by this file's own method rules. Every one of those
three sits inside it, so none of them clears. Read them as **free** and do not
re-derive a mechanism for the sign. Only the decal loop clears, and it clears by
five times the bracket.

## Phase 1 — THERE ARE NO FREE WINS. All four items are closed, none paid.

This section was the plan's optimism and it did not survive contact. Two items
were refuted by re-taken marginals, one by a measurement Phase 2 built to get,
and one by reading the materials. Nothing here is pending.


**1.1 (bake the props' matte light per vertex) is refuted as a millisecond
lever.** It was estimated at 1.1 ms; the ENTIRE dressing group's marginal at
four cells is 1.1 ms, below the bracket. You cannot take 1.1 ms out of a group
that costs 1.1 ms in total.

> Its DESIGN risk is settled anyway, and the answer is worth keeping because it
> was the thing blocking the item: the fear was that an object-space bake cannot
> survive instancing. It is moot. `vglb.mat` defines `TTP_NO_SUN_SHADOW`, so
> `ttpMatteLight` reduces to ambient + sun and is a function of the WORLD NORMAL
> alone — `uwp` is unused. Moving it to the vertex stage therefore handles
> instancing for free, needs no bake and no per-instance sun transform, and
> `vground.mat` already does exactly this via the same include's
> `TTP_SHADE_VERTEX` guard, packing the light into the unused `fog.yzw` that
> `vglb` already declares. What it does NOT buy is the tangent fetch: vground
> keeps `requires: tangents` for the vertex stage's own normal, so the part of
> the estimate charged to decoding a tangent quaternion was never available.

**1.3 (orient the billboards once per frame) is refuted.** Its whole case was
the sky group's 0.22-at-1-cell against 2.15-at-4. That gap is now 0.2 against
0.8. The bypass collected it, exactly as the item's own stated range allowed.

**1.2 (drop the fog's per-vertex `sqrt`) is REFUTED, measured.** It was priced
at 0.5-0.8 ms on ~515k vertices. Phase 2 built the bit it needed
(`TTP_FEAT_FOG_VERTEX`) and the answer is null: the WHOLE per-vertex fog term —
the `length()` and the `exp()` together, not just the sqrt the item wanted to
remove — reads **-0.57 ms with the sign flipping across three interleaved
pairs**. If removing both transcendentals measures nothing, removing one cannot
measure something. Closed.

**1.4 (audit the vertex attribute streams) is DONE, and found nothing.** Every
`requires` entry on all sixteen scene materials is read — checked include-side
too, which is where three of them hide (`ttp_glb.inc` reads the uv0 `vglb`
declares, and so on). There is no `uv1`, no dead `color`, and no mesh emitting
an attribute its fragment never asks for. The road already stopped emitting
tangents; that was the last one.

> The one that LOOKS dead and is not: `vglb`, `vlit`, `vlitns`, `vground` and
> `vvis` all declare `tangents` to obtain a world NORMAL, not a tangent frame.
> Filament has no normals-only request — `requires: tangents` IS how a material
> asks for a normal — so the quaternion fetch and decode cannot be dropped
> without dropping the lighting. Do not re-file this as a saving.

## Phase 2 — DONE (2026-08-23). Both bits built, both answers negative.

`TTP_FEAT_GRADE` (0x4000) and `TTP_FEAT_FOG_VERTEX` (0x8000) ship. They ride a
Filament VIEW GLOBAL rather than a material parameter — eleven materials include
each of the two `.inc` files, and `frameUniforms.custom[0]` is set once per view
and readable from both stages by all of them. The sense is ABLATE, not ENABLE,
so an untouched View renders the shipped picture.

Measured 4P/1080, three interleaved pairs on one install, baselines bracketing to
0.47 ms:

| channel | pair deltas | verdict |
|---|---|---|
| **the grade** | +0.581 +0.779 +0.711 | **0.69 ms**, 3/3 same sign — REAL but small |
| the fog's vertex half | -0.536 +0.151 -1.326 | **null**, sign flips |

**2.1 answered: the grade is 0.69 ms at 1080, which is 0.17 ms at 540.** Real —
the paired spread is 0.2 ms, so it clears easily despite sitting under the ±1.2
unpaired noise figure, which is precisely what interleaving buys. But at the rung
that matters it is a sixth of a millisecond against a 7.9 ms tail gap. It was
refused twice on look grounds; those refusals were right, and now they are right
for a measured reason. **Do not re-propose the grade, or the sRGB swap chain that
was priced off it.**

**2.2 answered: null, and it closes 1.2** — see above.

**2.3 (a bit for the car-shadow layer's UPLOAD half) is NOT built, deliberately.**
Two readings already argue it is empty, and neither needs a build: the frame map
puts the whole main-thread upload work at `decalUp` 0.2 ms and `skids` 0.2 ms,
and the tail fit inflates the FILL half by 40% alongside the fixed half, which is
a heavier picture rather than a stall. An upload spike would move the fixed half
alone. Build it only if some later evidence points back at uploads.

## Phase 3 — priced quality trades, gated on CELL COUNT

None of these ship globally. The box only misses 60 at four cells, and a
quarter-screen cell is where each is least visible. The mechanism is a C++
decision keyed off `cells`, the same shape as `kScaleEscapeCells` — never a
shell's opinion.

**The deck decal channel is no longer one lever among five; it is the board.**

| lever | measured at 4P, 540 / 1080 | what it costs |
|---|---|---|
| **the deck decal channel off** | **1.61 / 6.45 ms** | car shadow silhouettes and road paint |
| terrain thinned | ~0.5 / 2.1 | ground, hills, water, pillars, berms |
| deck decal caps halved | untested; a fraction of the 6.45 | fewer simultaneous stamps |
| sky group off | 0.2 / 0.8 | below the bracket. Not worth its look |
| `dress_keep 0.5` | 0.3 / 1.1 | below the bracket. Not worth its look |
| the grade off | 0.17 / 0.69 | MEASURED and too small. Refused twice on look; closed |
| fp16/mediump on the SPIR-V path | unpriced | banding risk, per-backend blobs |

**Everything on this board except the decal loop and fp16 is now measured and
too small.** That is the state Phases 0-2 leave behind: one look trade of real
size, and one unturned stone.

On the last: it is filed everywhere as a FILL lever, but the fixed half is
vertex ALU and fp16 runs at 2x rate there too, so it should cut both halves.
That makes it worth more than its filing suggests, and it is the one
consciously unturned stone.

**What the decal loop actually buys**, carried through the model:

|  | today | decal loop cut at 4 cells |
|---|---|---|
| 540 p50 / p95 | 15.9 / 24.6 | **14.3 / 21.8** |
| 720 p50 / p95 | 22.0 / 33.0 | 19.1 / 28.0 |
| break-even | 567 lines | **637 lines** |

So it moves the break-even past the 600-620 the plan hoped Phases 1-3 together
would reach — on its own. **It does not close 540 at 60 on its own**: the worst
second still reads 21.8 against a 16.7 budget. Halving the caps rather than
cutting the channel buys proportionally less.

Cutting it is a LOOK decision and not this plan's to make. The cure is priced;
the trade goes to the user.

## Phase 4 — the policy decision, once the milliseconds are in

The escape below the floor currently trades the RATE (540 lines at 30). The
ladder's own principle below the anchor is that RESOLUTION gives way first. So
the shape of the answer is a rung, not a rate:

- 960x540 at 30 fps, shipped today
- 768x432 at 60, or 640x360 at 60

What Phases 1-3 do is move the break-even off 540's shoulder so the rung gains
the margin a p95 needs. Taking the escape out entirely is the last step, and it
needs a long adaptive run rather than a pinned arm to confirm.

**The tail's own shape, fitted 2026-08-23.** The worst second fits the same
model with both halves inflated — `fixed 13.72, fill 43.42` against the typical
second's 8.10 / 31.17. A single CPU or upload spike would move the fixed half
only. Both move by about 40%, so the worst second is a genuinely heavier
PICTURE — the busiest corner of the lap — and not a stall. That is why content
levers reach the tail at all, and why chasing a spike would have been wasted.

## Not on this plan

Each of these cost a build and a sweep already, and the reasons are in
`shells/androidtv/CLAUDE.md` and `native/renderer/CLAUDE.md`:

pass structure and the Vulkan `renderArea` patch; varying bandwidth (the
`vertex_position` fork patch, sign-flipped null); draw-count cuts (under Vulkan
draws are cheap and vertices are not); distance LOD, fog culling and
object-granular culling (the fog saturates where the scenery ends, so there is
no far field to grade); wheel LOD; spatial bucketing of the merge; coarser world
geometry (-0.4 ms of GPU against +0.55 ms of frame thread, reverted); pipeline
cache prewarming (the box does not advertise the extension it needs); the sRGB
swap chain (a 3.5 ms LOSS on this driver).

**MULTIVIEW IS OFF THE PLAN.** It is a GL-only arrangement, it is moot under the
Vulkan default, it needed two defect fixes and a black-frame probe before it was
safe on real drivers, and at four cells it bought +2-3 fps of tail and nothing
of the median. It is not a lever for this goal.

Also settled: at four cells under Vulkan, merged and unmerged draw groups are a
wash. Keep the locality merge, justified by the counts it strictly reduces.

## The method rules every arm here is gated on

The full versions live in `shells/androidtv/CLAUDE.md`; these are the ones that
have produced a confidently wrong answer before. Phase 0 tripped the first one
in the ledger it was sent to check, which is the whole argument for keeping it
at the top.

- **`--vk 1` on EVERY arm.** Unflagged, `perf-race` pins GL on purpose, and that
  is **+10.9 ms at four cells** (measured 2026-08-23). `perf-frame.mjs` does not
  write the property AT ALL and inherits whatever the box was left on — set it
  by hand before driving that script.
- **Pin the scale**, which takes the render-scale rule and the 30 Hz escape out
  of the arm together (`adaptScale` early-returns on a pin). An unpinned 4-cell
  arm measures a downclocked GPU against a 33 ms budget, and reads a rock-steady
  30 fps with ZERO skips, which looks like health.
- **Interleave pairs on ONE install, at least three, sign checked across them.**
  Pairwise noise is ~1.2 ms at 1080 and ~0.5 at 540.
- **Read at 1080 pinned, not 540.** A single 540 arm drifts across a day; a
  repeated 1080 arm reproduces to 0.18 ms.
- **Bracket a sweep with a repeat of its own baseline**, and refuse any marginal
  narrower than that bracket.
- **Quote p50 AND p95.** A median of 15.9 with a p95 of 24.6 delivers 49 fps.
- **Geometry counts on the HOST** (`perf-features.mjs`, deterministic); let the
  box confirm only the sign.
- **Verify the change is in the installed APK** by grepping a marker inside it.
  `npm run build:androidtv` silently rebuilds the stock `.so` over a staged one.
- Kill Studio mirroring before benching.
- The box's adb-over-TCP link drops when it is left idle. Reconnect before every
  arm, and keep the screen from sleeping, or a sweep loses arms in the middle.
