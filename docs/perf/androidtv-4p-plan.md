# Getting four-player split to 60 fps on the Android box

The goal, and the only one this plan serves: **four cells at 60 fps, at the
highest resolution rung the box will hold.** Not a rate escape, not a 30 Hz
mode. It is reached iteratively — every phase below either buys milliseconds,
which convert into lines, or buys certainty about a number that is currently
contradictory.

**Reached, 2026-09-02** — by the deck's far ribbon and two render-scale
retreat rules, neither of which is a phase below: an adaptive 4P race on the
box runs at 60 fps for 128 of 150 s, mostly at 640x360 with stretches at
768x432. `androidtv-frame-map.md`'s 2026-09-02 section has the readings; the
phases here stay as the ledger of what was priced on the way.

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

**THE CRITERION IS `skips/s`, NOT `p95 <= 16.7`** — corrected 2026-08-23 by the
ladder in Phase 4, and this file said the wrong thing first. Every rung this box
runs, including one that holds a locked 60 with zero skips, reads a p95 well
over 16.7. Extrapolating a two-point TAIL fit downward is what produced that
error; it predicted 60 fps needed ~283 lines, and 640x360 does it at 360.
Measure the rung, do not model it.

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
| ~~fp16/mediump on the SPIR-V path~~ | **REFUTED, see below** | — |

**THE LAST UNTURNED STONE IS TURNED, and it was refuted on the HOST — no device
time, no build to bench.** The plan argued fp16 was worth more than its filing
because the fixed half is vertex ALU. The filing was wrong in a different way:
the ALU that could be demoted is not ours to demote.

Counted as RelaxedPrecision decorations in the SPIR-V unzipped from the shipped
APK, which is deterministic where a device arm this small would be noise (the
same reason this file already counts geometry on the host):

- **The fragment stage is ALREADY 40-53% relaxed.** What remains highp there is
  vroad's decal and arclength maths, which that file documents as load-bearing:
  mediump quantized a world arclength to half a car length and the car shadows
  vanished. Not demotable.
- **Every VERTEX variant of every material is 0% relaxed** — GLSL ES defaults
  that stage to highp — but the 260-282 arithmetic ops in the shipped variants
  are FILAMENT'S generated transform pipeline: skinning, morphing, instancing,
  qtangent decode, clip position. Demoting it means forking Filament's shader
  generator AND demoting positions, the exact class of value that already broke.
- Our own shading, demoted properly, moves **+11 vertex ops on vground and +8
  fragment ops on vglb/vlit — and ZERO on vroad**, which is 15 ms of a 38.8 ms
  frame and never calls the shading path at all (its light is baked into
  custom0). Ceiling, granting fp16 double rate and charging it the whole of the
  groups it touches: **under 0.2 ms**, against a rung step of 1.0-1.5.

> A SPELLING TRAP worth keeping, because the first attempt measured nothing and
> looked like a refutation: **declaring a function's RETURN TYPE mediump relaxes
> no arithmetic.** The operands are highp uniforms, so the maths runs in highp
> and only the result is converted. It needs mediump LOCALS — copy each uniform
> into one first. Return-type-only changed exactly 0 instructions across four
> materials and twelve variants; the locals version changed 114.

**What is left on this board is the deck decal loop, and nothing else** —
decomposed into its sub-channels in Phase 5, which is where the lever's real
name turned out to be the MASKED half alone.

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

## Phase 4 — THE LADDER, MEASURED (2026-08-23). 360 already holds 60.

Two passes each, 4 cells, Vulkan, scale pinned, tidepool. This is the table the
whole plan exists to produce, and it needed no code change to get:

| rung | fps | skips/s | gpu p50 | gpu p95 | |
|---|---|---|---|---|---|
| 960x540 | 52 | 7.5 | 15.68 | 23.88 | the shipped rung; misses badly |
| 853x480 | 57 | 3.0 | 14.24 | 22.88 | |
| 768x432 | 59 | 1.0 | 12.86 | 21.33 | **one skip a second short** |
| **640x360** | **60** | **0.0** | 11.50 | 19.40 | **LOCKED, today, unmodified** |

**So the escape does not have to trade the rate at all.** 640x360 at 60 is
available now, and 768x432 is a single skip per second away — which is inside
what one lever buys.

**A lever's worth is best read in RUNGS, not milliseconds.** The decal loop is
6.45 ms of fill at 1080, and carried down this ladder it moves each rung to
almost exactly where the next one down sits:

    540: 15.68 - 1.61 = 14.07  ~= 480's 14.24
    480: 14.24 - 1.27 = 12.97  ~= 432's 12.86
    432: 12.86 - 1.03 = 11.83  ~= 360's 11.50

**The deck decal channel is worth one rung.** Cut at four cells it should put
768x432 at a locked 60, or 853x480 within a skip. That is a much stronger case
than the earlier framing on this page, which measured it against the p95
criterion and concluded it bought only margin. It buys a rung; the criterion was
wrong, not the lever.

### Verified against the new rate-step rule (2026-08-23, `621f87c3`)

That commit made the rate step two-way, and its message notes the floor escape
"comes back with it". At four cells on this box **it changes nothing**, and the
adaptive run says so end to end — 150 s, four cells, no pin, on a build carrying
the fix:

    960x540 @ 30 fps, 0 skips/s, gpu p95 18.03    131 of 142 readouts
    FINAL:  960x540 @ 30 fps

**It parks on the escape and provably cannot climb out.** The climb gate is
`gpuP95 <= kScaleTargetShare * budget` = 0.85 x 16.7 = **14.20 ms**, and 540
costs **18.03**. That refusal is CORRECT — 540 at 60 measures 52 fps and 7.5
skips/s — but it is also terminal, because the escape gave up the RATE and the
only way back is at the same resolution.

`gpuP95Ms` is `PerfMonitor`'s own fold (`render_scale_controller.cc`), the same
`gpu.p95` the readout prints, so these are directly comparable. Note it is the
MEDIAN of a run's window p95s, not `perf-race`'s worst-p95 column.

**So the escape has to give up RESOLUTION, which is this ladder's own stated
principle, and the numbers now say it plainly.** 640x360 holds a locked 60 with
zero skips; its p95 median is 14.34 against the 14.20 gate, i.e. inside the
14.20-15.03 deadband, so a point placed there would be stable rather than pumped.
Nothing above 432 can ever climb back to 60 on this box.

## Phase 5 — the decal channel DECOMPOSED (2026-08-24), and the lever named

The knobs that took every arm below ship in `ttp_display.h`
(`TTP_DEBUG_NO_DECAL_*`, `DECAL_CAPS_HALF`, and the two mechanism probes) —
inverted bits outside `TTP_FEAT_ALL`, so `TTP_FEAT_ALL | bit` ablates one
sub-arm on one install. All arms 4P/1080 pinned, Vulkan, tidepool, on
`1.0-6fa59af0-dirty`; the sweep bracketed to 0.52 ms, the verdicts by three
interleaved pairs.

| sub-arm | marginal | verdict |
|---|---|---|
| **the MASKED silhouette loop** | **7.07 ms** (−6.73/−6.80/−7.68, 3/3) | **the channel IS this** |
| caps halved (pick budget 2) | 3.42 | linear in stamps |
| the profile loop (auras + statics) | 1.08 | barely above bracket |
| statics only (slicks, item discs) | 0.73 | ~bracket |
| the far blob tap (raster+upload+tap) | −1.42 | free, like the rubber tap |
| the whole channel (anchor) | 7.19 | reproduces Phase 0's 6.45 |

Four own-car stamps, ~1.8 ms each. Two findings that reshape earlier phases:

- **At 4P the masked pick is ALREADY own-cars-only** — the budget (4) is
  consumed by the every-view's-own-car round, so "cap masked to the own car at
  4 cells" is the shipped behaviour, not a lever, and shrinking
  `kShadowLodFar` at 4P is structurally empty (own cars sit ~2u away with no
  distance gate; everyone else already rides the blob).
- **The mechanism, split by the two probes.** MASK_COUNT0 (folds and uniform
  writes exactly as shipped, shader count zeroed) recovers 6.6 — so the
  per-frame chunk-UBO rewrites are FREE and the cost is execution.
  MASK_BOUNDS0 (loop armed, box impossible) recovers only 4.3 — so ~2.3 ms is
  paid by a stamp chunk's fragments merely for `maskCount > 0`, before any
  fragment enters the loop, and ~4.3 ms is the loop's own fragments.

**The silhouette FETCH is not the cost either — measured (2026-08-24), and it
closes the whole texture line.** The MASK_FLAT probe (the tap answers a
constant; projection, feather and mix run in full) reads -0.30 / -2.09 /
-0.36 across three interleaved pairs — sign-consistent, median ~0.35 ms, a
minor slice of the ~4.3 ms the executed loop costs. So the money is the
per-fragment PROJECTION MATH on the densest fragments plus the armed-path
residue, not the sampler: an analytic-shape silhouette (which would keep the
projection and drop only the tap) is refuted WITHOUT being built, and no
texture format or resolution change can ever pay. Do not re-file either.

**The mediump escape is refuted too (2026-08-24), and it was the last one.**
Demoting the masked loop's PROJECTION maths to fp16 locals (rel/dots/feather —
the subset where fp16 is millimetres, leaving the load-bearing arclength fold
highp) measured a NULL leaning slight loss: 39.85 against 38.95 across three
runs a side. The conversions cost what the narrower registers save. With the
fetch, the writes, the pass structure and the precision all measured, the
masked channel's cost is CLOSED: nothing implementation-side collects it.

**The 480 rung is the trade's real prize, measured on the ladder:** with the
masked arm off, 853x480 reads 59/1.0 then 60/0 twice — the blob trade alone
effectively locks 480@60, one rung sharper than the 432 first quoted, and
adding the profile channel (60/0 twice, more margin) is held in reserve.

**The NEAR-SHADOW CASCADE is built, measured and refuted too (2026-08-24),
and it completes the attribution.** The full texture-space escape — the four
silhouettes CPU-rastered per frame into a high-density windowed R8 atlas (the
blob layer's idiom at 50+ texels/u), the masked loop's body reduced to two
fmas and one clamped tap, verified pixel-correct on the box — buys **-0.80 ms
at 1080** (-1.32/-0.17/-0.92, sign-consistent), a fraction of the ~4.3 ms the
executed loop costs. With the fetch at ~0.35 (MASK_FLAT) and the projection
ALU at ~0.8 (this arm), the executed remainder is the LOOP'S OWN STRUCTURE:
dynamically-indexed uniform reads per entry inside divergent flow — the
declared-size law measured from the execution side. Reverted; the masked
channel now has FIVE measured dead escapes (pass structure, fetch, precision,
uniform writes, texture-space) and is closed for good. The rank gate is the
only lever, and it is a look decision.

**THE DEPTH-EQUAL STAMP PASS IS BUILT, MEASURED AND REFUTED — do not rebuild
it.** The obvious structural escape — draw the four stamps as their own
transparent renderables over ring ranges of the road's shared buffers, depth
EQUAL so each fragment lands exactly on the road fragment it shades, masked
loop structurally dead in vroad — renders CORRECTLY (silhouettes, aura
compositing, occlusion by car bodies all verified on the box) and buys
NOTHING: three interleaved pairs read +(-0.2)/+1.3/+1.1 ms against the
baseline. Shading those fragments costs ~7 ms on this GPU whichever pass
issues them; there is no pass arrangement to collect it, the same law the
per-cell-RT and renderArea experiments hit. The prototype is reverted
(2026-08-24); its design and this refutation are what remain.

**What the masked lever is worth on the ladder, measured with the arm on**
(`TTP_FEAT_ALL | NO_DECAL_MASKED`, i.e. every car on the blob at full alpha —
the real fallback picture, since the blob path already crossfades and cannot
pop):

| rung | baseline (Phase 4) | masked off |
|---|---|---|
| 960x540 | 52 fps, 7.5 skips/s | 58 fps, 2.0 |
| 853x480 | 57, 3.0 | 59, 1.0 |
| **768x432** | 59, 1.0 | **60 fps, 0.0 skips — LOCKED** |

So the plan's own target — the highest rung that holds 60 — is **768x432 with
the near silhouettes traded for the blob**, one C++ decision keyed on
`cells >= 4`, the `kScaleEscapeCells` shape. The look cost is exactly: the
car-shape silhouette under the four near cars becomes the soft superellipse
blob, at quarter-cell size. Auras, slicks, item discs, paint, rubber and far
shadows are untouched (and their arms priced too small to be worth their
look). The alternatives stand: 640x360@60 with no look change, or today's
960x540@30. The trade is the user's call (no-perf-for-cosmetics); nothing is
wired until it is made.

## Phase 6 — WIRED (2026-08-24). The plan's goal is reached.

The user took the blob trade, and both halves shipped in one commit:
`kMaskedBlobCells = 4` zeroes the masked pick budget at four cells (the rank
gate degrades every car to the die-cut blob, which crossfades and cannot
pop), and the scale rule grew the split's SUB-FLOOR RUNGS — 360/432/480 at
the panel's own rate, ranked above the half-rate backstop, offered only where
the escape is. Below the floor a split now gives back resolution before rate,
which was the ladder's own principle finally applied to the one place it
wasn't.

**Wiring it exposed a SECOND one-way door, same disease as the rate step's**
(`621f87c3`): parked at the backstop, no up-branch could ever fire — the fit
needs two scales, the no-data probe was blocked by a same-scale observation,
and the raw share gate compared the backstop's own DOWNCLOCKED paced span
(14.57 measured) against the next point's 14.20 gate. The escape's exit is a
probe by right now: a climb out of a rate-trade into strictly fewer pixels at
full rate is taken on tenure alone, and a wrong probe retreats within one
evidence window. `render_scale_check` pins both directions (the hopeless box
keeps returning to the backstop; the rescued box climbs out and stays out).

**The acceptance walk, adaptive, unpinned, 4P tidepool on the box:** descent
through the grid, settle at 640x360@60 locked (gpu 11.6, 0 skips), one
model-driven climb to **768x432@60 LOCKED (gpu 12.4, 0 skips)**, held to the
finish — still climbing when the race ended, so longer races may reach 480.
No 30 Hz anywhere. (A 150 s fold of that run reads "fps 31" — the bench race
ENDS inside the window and the fold averages the results board; the method
note in `shells/androidtv/CLAUDE.md` exists for exactly this.)

**540@60 is refuted as a lockable rung, for good:** with the trade it reads
58 fps at ~2 skips/s, and the tail fit says why nothing closes it — the worst
second is a heavier PICTURE (both cost halves ~40% up), and even the whole
decal channel ablated left 540's worst second at 21.8 against 16.7. The
sharpest clean rung is what ships, and that is 432 today with 480 in reach.

## Phase 7 — 540@60 INVESTIGATED AND CLOSED (2026-08-24). It costs the terrain.

Asked for directly after the wiring, and answered with a matrix and one last
probe, all at pin 0.5 with the blob trade on:

| 540 config | fps / skips | gpu p50 / worst |
|---|---|---|
| the trade alone | 58-59 / 1-2 | 14.3 / 22.6 |
| + profile channel off | 59 / 1 | 13.3 / 21.0 |
| + sky off | no help (noise) | — |
| + TERRAIN OFF (ceiling probe) | **60 / 0 — locked** | 11.3 / 18.1 |

So the lock exists ~1.5 tail-milliseconds away, and the only measured thing
that closes it is deleting the whole terrain — ground, hills, water, pillars,
berms — which is not a picture anyone ships. The profile channel gets within
one skip and costs the boost auras, which are gameplay feedback.

**The FOG EARLY-OUT was the last untried lever, and it is refuted:** vroad
and vground answering the fog colour outright past 95% opacity (skipping
their taps and the grade on exactly the vista fragments the tail is made of)
measured NULL across three interleaved pairs — +0.32/-0.02/+0.07 with skips
moving randomly. The far picture was already nearly free; the expensive
channels were box-gated to the near chunks all along ("the deck's cost is
the one or two chunks under the cameras", measured again from a new angle).
The probe is reverted.

**540@60 on this box is therefore CLOSED**: no shippable lever reaches it.
The sharpest clean rungs remain 432 locked (shipped) and 480 within the
model's reach on longer races. A meaningfully faster GPU is the only door.

## Phase 8 — the quality-compromise sweep (2026-08-24). Pinned 540 locks; adaptive races still refuse it.

Asked with compromises explicitly allowed, and swept to the end. At pin 0.5
with the blob trade on:

| + lever | passes | look cost |
|---|---|---|
| rubber layer OFF | **60/0 x3 — locks** | no skid marks at 4P |
| skid uploads throttled (10 Hz / 2 Hz) | 59/1 x3 | trail lag REJECTED on look; only the mip half ships (2 Hz at 4 cells, invisible) |
| throttle + statics off | 58/2, 60/0, 60/0 | slicks/discs gone, auras kept |

> **SUPERSEDED 2026-08-26 — the level-0 upload throttle is GONE.** This phase
> concluded that "the rubber layer's cost is its UPLOAD EVENTS, as the GL-era
> A/B concluded", and the ~30 Hz level-0 throttle shipped on it. But the arm
> in the table above is **10 Hz**, and it reads 59/1 against the whole layer's
> 60/0 — so even here the uploads were not the whole cost, and the 30 Hz rate
> that actually shipped was never priced on its own. Measured directly (4
> players, tidepool, Vulkan, pinned 720, three interleaved whole-race reps an
> arm): 30 Hz against no throttle is a NULL — 43 fps both, 20.08 vs 19.87 ms,
> 17 skips/s both — while ablating the layer whole moves 43 -> 48 fps with no
> overlap. The layer's cost is the TAP and the CPU raster; the trail lag was
> being paid for nothing, and `renderSkids` now uploads every stamp frame.
> Only the MIP half keeps a throttle (2 Hz at four cells, invisible).
> `shells/androidtv/CLAUDE.md` carries the standing version of this.

**But the adaptive verdict is final, and it is no.** A real race run with the
best recipe spends its GRID in the backstop (the pack is the heaviest picture
of the whole race), probes out, and settles 432@60 — the pinned 60/0 reads
were the calm majority of the lap, and the race's worst seconds (skips-worst
6/s even under the recipe) are ~25% over 540's pixel budget on this GPU.
Pinned 540 is lockable; PLAYED 540 is not. 432 locked with 480 in late-race
reach remains the shipped truth, and the statics arm is not wired — at 432
its margin buys nothing.

## Phase 4 (cont.) — the policy decision, once the milliseconds are in

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

**MULTIVIEW IS OFF THE PLAN, and the path is DELETED.** It is a GL-only
arrangement, moot under the Vulkan default, it needed two defect fixes and a
black-frame probe before it was safe on real drivers, and at four cells it
bought +2-3 fps of tail and nothing of the median. It is not a lever for this
goal; `shells/androidtv/CLAUDE.md` carries the removal note.

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
