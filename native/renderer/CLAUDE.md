# native/renderer/ — the Filament renderer

`runtime/ttp_display.h` drives it: per frame the shell calls
`ttp_display_frame(dt)` and C++ reads the live `Game` to build the renderer's
input in place. **Nothing about a car is ever serialized to JS and handed back.**

The platform-free half — camera rigs, fog profiles, the frame-input builder —
lives in `libttp-runtime` and is executed on every leg by `runtime_check` and
`frame_builder`. This directory needs the Filament SDK, so **no ctest compiles it**.

## What the renderer draws that a shell might expect to own

**Cell-anchored AND textless goes to the renderer; anything carrying type or
sticker chrome stays in the shell.** That is the steer bar and the cell dividers,
both pinned to a cell whose geometry is already C++. It keeps OUT the place/lap
ordinal, the name chip, the item slot, the FINISHED card and the reconnect QR.

**They take no unit from the shell.** The bar derives from its own cell and the
screen — a damped share of screen height, so a split shrinks it by the square root
of the share rather than proportionally (straight proportion read oversized at one
player). **Both terms are load-bearing:** drop the screen term and the bar halves
on a 4K panel, which is the devicePixelRatio trap this layer already refuses; drop
the cell term and a split stops mattering. `BAR_SCALE` is the ONE knob.

> There **was** a `ttp_display_ui_scale` carrying devicePixelRatio. It is gone. A
> shell porting from an older revision should **delete the call, not look for a
> replacement** — a UI point needs the panel's physical size and a viewing
> distance, and a TV shell has neither.

The dividers keep a canvas-relative weight, because their span is the canvas too.

The renderer's HUD block (`TTP_HUD_*` in `ttp_render.h`) is the only place the ink
and surface tokens are written down twice, held to `theme.css` by
`tests/design-tokens.test.js`.

The surrounding cell chrome is shell-drawn in CSS pixels and does **not** scale
with the split. That asymmetry is a known open question, not a settled rule.

## Framing: two grids, and only one is where the picture is

`ttp_grid_cell` tiles the RAW surface. `TtpRenderer::cellRect` fits that grid into
the `CELL_BASE_ASPECT`..`CELL_MAX_ASPECT` band **as one piece** and centres it, and that is what the race
cameras render into. Whatever the band trims is a bar — a rendering decision, no
part of the layout scoring.

**The band is a cell's rule and only a cell's.** An overview — lobby orbit,
gallery turntable, track preview, inspector cam — takes the surface ENTIRE and
says so with `TTP_FRAME_OVERVIEW`. The renderer cannot infer it, since one cell
and one overview are both `viewCount` 1. Getting it wrong letterboxes the lobby
*and* aims its projection at a shape it is not drawn into.

**Anything placing chrome wants `cellRectTopLeft`**, so the shell's chips and the
renderer's steer bar cannot land on different grids. This bites in ordinary play,
not just on an ultrawide, because the 2-player layout is stacked and gets fitted.

The **divider span** is the deliberate exception and stays the whole canvas, since
a rule stopping at the picture's edge would read as a gap. **Which** edges get one
is "cells on both sides", never "away from the border" — the grid is centred, so
testing against 0 draws a rule down the left of an ordinary 2-player pair.

> Every fixture and every ordinary TV is 16:9, the one surface where the fitted
> rect IS the surface. Framing bugs therefore hide from the whole suite unless a
> check drives several surface shapes. `frame_builder` does.

## The lens: a cell is a small screen, not a crop of a big one

The vertical fov is the rig's authored one in EVERY layout. The only thing a split
may do is **widen** the picture inside the band, which ONLY REVEALS more world at
the sides — a wide cell is not the base stretched or pushed back, and the base is
a crop of what a wide one shows. That is why the floor is hard (narrower would
HIDE world) and the cap is only taste.

**Three height fractions shipped before that; do not reach for a fourth.** Each
scaled the fov by the cell's share of some height. Against the surface's height or
the single-cell picture, the letterbox bar landed in the lens, so resizing the
window swung the fov in split-screen only. Against the grid's height that was
fixed, but the layout is the wrong thing for the lens to depend on: a 2-player
pair is stacked on 16:9 and side by side on an ultrawide, so the same two players
got different cameras depending on the window. All three agree at one player on
16:9, which is why no fixture and no TV would ever have shown it.

**A HELD field's chase rig follows the PICTURE, not the sim.** `ttp_display_hold`
parks the bodies at the pose they were last drawn at; the camera has to be parked
against the same pose, because the two are not the same thing at a race's end. The
the hold is taken at the END of the finish flourish and the burst that follows
resolves every car still running — the AI to the flag, the just-finished human
around a victory lap — so a rig fed the live car sails off down the track and
leaves the parked body behind it. That was invisible for as long as the results
board covered the frame within a frame or two of the flag; now the board fades up
over that held frame and the discrepancy is on screen.
`frame_builder`'s held-camera case is the gate.

## The deck is a ruled surface, and the car sits on it

Every DECK point of the road's cross-section is at `y == 0` in the frame, so at
each arclength the drivable deck is a straight LINE across and the whole surface
is that line swept: `P(s, lat) = frameAt(s).pos + frameAt(s).lat * lat`. Two
consequences run through everything that puts a car on it:

- **Across the car there is nothing to fit.** Two wheels at the same arclength
  are exactly coplanar with the deck, at any bank.
- **Along it there is.** Where the deck twists, consecutive rulings are SKEW
  lines, so a rigid body's four wheel corners are genuinely not coplanar and NO
  pose lands all four. That residual is the WHEELS' travel to absorb. A body fit
  that tries to absorb it is the mistake — it is what the old crest guard
  (`max(axleMean, centreProbe)`) was patching around.

So: the body takes the best-fit plane through the four contacts and each wheel
takes its own residual as a local-Y offset. Measured over the catalogue, the fit
turns the body by up to ~3.4° from the contract pose's own up, and the residual
the travel absorbs reaches ~0.04u.

**The probe is an EVALUATION, not a search.** The sim hands its `(totalS, lat)`
across in `TtpCarInput`, and `deckFoot` walks that seed to each wheel's foot by
Gauss-Newton on the surface above. Nothing in the path picks a nearest triangle
or a nearest ring, so nothing in it can HOP. That is the whole lesson of the
attempt that was reverted on 2026-08-02: it fitted the same plane to four
`project()` probes, whose discrete segment pick put ~0.4° of lean noise per frame
into the body.

**Nothing in the conform is damped, deliberately.** A filter was what the old
straight-down raycast needed, because it read TRIANGLES and stepped at every deck
seam; it bought smoothness with lag, and lag on a hill drags the car behind its
own contract position. The analytic surface is smooth to begin with. **If a
filter ever looks necessary here again, the probe is what is wrong.**

**`deckFoot`'s step clamp is not a tuning constant.** Where the deck curves
tightly, a lateral offset approaching the corner's own radius makes the offset
curve nearly stall, `|dP/ds|` collapses, and an unclamped Gauss-Newton step
explodes — measured on cloverleaf as a 21u jump that "converged" onto another
part of the circuit and arrived as one frame of 58° of lean.

**The check that can fail on lean** is the fitted normal's second difference
against the CONTRACT normal's, on the same frames. The contract normal is NOT
smooth by construction — it lerps the knot ups — so it is a real baseline and
not a formality; the reverted attempt had no reference for this half of the pose
at all, which is exactly how it shipped with the lean wobbling. Read both off
`ttp_display_debug_decals` (`upJitter` beside `jitter`/`rawJitter`), and see
`?scenario=warp` for the bench that isolates one warp per leg.

## Decals are shaded into the road, not laid over it

Flat on-deck decals are handed to `vroad.mat` as track-space rectangles and
painted by the road's own fragment shader, so a decal's fragment IS a road
fragment at the road's own depth: **no lift, no chord sag, no polygon offset, no
render order.** The road carries arclength in uv0, which is also why loops work —
a fragment knows its own arclength where one `(x, z)` has two.
`ttp_display_debug_decals` reads the packed floats back; use it rather than
inferring shader state from pixels. It covers the DECAL channel only — the
paint channel (below) is written straight to the chunk instances and has no
readback.

**Three things cost a debugging round each:**

1. Filament flips V by default and uv0 here is not an image coordinate, so
   `flipUV : false` — or every decal lands by the far kerb.
2. **The deck mask is a per-vertex FLAG, not a threshold on v.** Thresholding
   failed both ways: as a fraction of half-width it excluded real road where the
   track narrows, as raw lateral it clipped decals to a middle band. The section is
   a CLOSED ring, so track space is written only on strips with both endpoints at
   ground level — otherwise the underside inherits the deck's lateral range and
   takes every decal with it, invisible on a flat track but sticking a boosting
   car's aura to the outside of a loop.
3. A `MaterialInstance` from `sceneInstance()` is scene-scoped, so a member holding
   one must be nulled in `releaseScene()`.
4. A per-frame decal centre must agree with **what the rasterizer computes
   from uv0** — nothing less settles. `project()` reproduces it stage by
   stage: the road's own ring polyline (never the raw contract samples), the
   ring-plane blend (never a perpendicular onto the chord), and finally the
   exact per-triangle interpolation of the deck quad, because uv0 is linear
   per triangle and kinks at every diagonal. Every cheaper approximation was
   tried and each one still saw-toothed the shadow a few cm at ring-crossing
   rate under a cornering car; `project()`'s comment has the measured ladder.
5. A texture sample under NON-UNIFORM control flow must be `textureLod`,
   never `texture()`: an implicit-derivative sample there is undefined
   behaviour. **The rule is the whole renderer's** — vroad's carShadow
   B-spline taps (behind the per-fragment probe gate), `sunVisibility` (early
   returns, then the tap) and vpresent's FXAA span taps (a contrast early-out,
   then four of them) are all `textureLod`. Every map involved is single-level
   and bound with a non-mipmap filter, so LOD 0 is exactly what an implicit
   sample would pick. It was learned in a per-fragment decal loop whose
   `continue` rejects made the flow non-uniform: on ANGLE's Metal backend its
   `texture()` read as the car shadow intermittently rendering nothing for a
   few frames — a flicker that vanished under every instrumented variant of
   the shader, because any reshape moved the UB. Every CPU-side input was
   verified sane at the failing moment before the sample was suspected; start
   there next time.

**One box gates the loop.** The entries a chunk carries CLUSTER while the chunk
is tens of metres of deck, so without a gate the road's biggest, nearest
fragments each ran every entry's reject to draw nothing. `profBounds` is the
union of the entries' own reject windows, so it is exact rather than
conservative: a fragment it rejects would have rejected each entry in turn.
**Build it from the same bound the loop tests** (`rect.zw`), or the box clips a
stamp the loop would have drawn.

**Chevrons are SDFs**, which let the pads move without a texture atlas. The apex
must LEAD or every chevron reads as a brake marking. A pad is **flat paint** —
reproducing the old mesh's radial gradient came out as an emissive saucer, the
exact read this tree rejected before. The static list is capped by
`kMaxStaticDeckDecals`, not the shader's per-chunk 8; the item boxes come
first in it, because the collect fade rewrites entry i's alpha in place.

**The asphalt patches (ttp/wear.h) and the boost pads are NOT decals** — they
are the deck's own PAINT, on their own channel composited BEFORE the rubber tap
while every decal composites after; the ordering rule and its reasoning are
below, under the skid marks. Paint entries carry the SAME layout as decals and
are painted by the same `paintStamp()`, so a pad cannot look different for
having changed sides, and they are written once per track straight onto the road
chunks, so none of it touches a per-frame path. They are also invisible to
`ttp_display_debug_decals`, which reads the decal list only.

**A chunk list that overflows its cap keeps the HEAD**, in both channels — one
`foldToChunk` does the periodic-arclength fold and the selection for each. Paint
uses that as PRIORITY, built pads first and repairs after, so decoration falls
off a dense chunk rather than a marker the player drives at; nothing is lost by
that order, because a repair and a pad can never overlap anyway (the planner
keeps a patch 4u of arclength clear of a pad). The decal list's order is
COMPOSITING order instead — statics, then auras, then the item blobs over both,
so an aura lands over the slick it crosses. A decal mix REPLACES what is under
it (the mesh era's premise was ADDITIVE blending), which is why the order is a
rule at all. The CAR shadows are not in the list: they are the carShadow tap,
composited BEFORE every decal, so a boost aura lands over its own car's shadow
— at the blob's near-opaque depth the reverse turned the aura's pulse into a
visible wave around the blob's edge (vroad.mat). Note the coupling — because
the order is also the cap priority, a full chunk drops the item blobs before
the auras.

Their grid is **a margin plus a packed run**, never one chevron per grid cell:
cells put more air between the marks than around them, so the outermost of them
crowd the decal's edge while the middle goes slack. Gaps are a fraction of a
mark's own size and the margin is what is left of the box. The **stroke is a
world width** while the layout stays normalised — that frame is anisotropic, so
one width in it is a different width on the road for every line ANGLE, and the
same expression gave a strip and a disc visibly different weights. The
rectangle's box height is **derived** from that stroke rather than frozen, or a
narrower strip clips its outer columns.

**EVERY car's contact shadow is the BLOB — one bilinear tap of the carShadow
layer — at every cell count.** That layer is a small track-space R8 texture the
renderer CPU-rasterizes per frame (the rubber layer's idiom — same (s, lat)
mapping, same lat span, so vroad's tap reuses the rubber uv) and re-uploads by
**DIRTY RECT** — the stamps' own, merged — into a **ping-pong pair** on GL and
Metal, so the upload never respecifies the texture the driver is reading, and
into **ONE texture bound once** on Vulkan (`uploadCarShadow` has both
arguments). **No per-frame path may re-point a road instance's sampler**: on
Vulkan each re-point rebuilds every road instance's descriptor set. **The
dirty rects are three frames deep for the pair** — a texture written every
OTHER frame was last correct two frames ago, and missing one frame's rects
leaves each texture holding the other's stale stamps, so the shadow strobes
between two positions — and Vulkan keeps the same history. The whole-level
upload it replaced is priced in the CPU table below.

**The deck's layer reads sample a bare varying.** vroad's rubber, car-shadow
and sun-vis uvs are affine in uv0, so the VERTEX stage computes them
(`layerUV`, `visUV`) and each read is non-dependent — one the GPU can issue
before the fragment shader runs, which on the PowerVR box was most of a
4P/540 skip budget (docs/perf/androidtv-frame-map.md). A new deck-layer tap
belongs in a varying too; arithmetic on the uv in the fragment makes the read
dependent again.

**The masked silhouette path was built, priced and deleted (2026-10-06); git
history has it.** Near cars once drew a baked GPU silhouette (an array layer
per car model, kept between runs in its own blob store) through a per-fragment
uniform loop in vroad, beside or instead of the blob, and a lab page with its
own ABI and an adb twin A/B'd every arm. Blob everywhere was the user's LOOK
trade, first at four cells and then everywhere; what made it a trade rather
than a loss is the per-car fitted shape below, because the near band's whole
argument was the car-shape under your own car. Its probe bits
(`NO_DECAL_MASKED`, `DECAL_MASK_COUNT0/BOUNDS0/FLAT`) went with it and are
holes in `ttp_display.h` — do not hunt for them. What it measured is the
durable half:

- **The cost was the per-entry DYNAMICALLY-INDEXED UNIFORM READS in divergent
  flow** — the four own-car stamps were ~7 ms of a 4P/1080 Android frame,
  the declared-size law (below) seen from the execution side. Per-frame
  uniform rewrites were free. Five escapes were built and refuted
  (`docs/perf/androidtv-4p-plan.md` Phase 5), and none is worth rebuilding:
  re-emitting the stamp's ring range as a transparent depth-EQUAL renderable
  (renders correctly, measures null — shading those fragments costs the same
  wherever they are issued, so do not file such a cost as "pass structure"),
  analytic shapes, texture formats, resolutions, and the NEAR-SHADOW CASCADE
  (silhouettes CPU-rastered into a windowed atlas, the loop body one clamped
  tap: ~0.8 ms back). Nothing spellable inside a per-entry loop collects it.
- **A per-chunk loop costs its BOUNDS BOX, not its entry count.** Raising the
  masked cap from 4 to 8 cost +4.96 ms p50 at 4P/720p while 1P measured zero
  (2026-08-20, three interleaved reps): eight cars put two in one chunk with a
  union box spanning both, so the fragments entering the loop multiplied as
  well as the iterations each ran. Ablating the whole channel had read like
  room to spare (~0.55 ms) — the trap. Raise a per-chunk cap only behind a
  tighter per-entry reject.
- **A budget shared by split-screen views must be a PER-VIEW round robin.** One
  global pool ranked by distance to the nearest camera starves the moment the
  screen splits: a bot drafting any player sits closer to that player's eye
  than the player's own car does at `CHASE_DIST`, so some OTHER player's own
  car lost its slot. No camera may be starved by another's picks.
- Deleting the loop, its arrays and its sampler measured ~0.3 ms lower in the
  4P heavy seconds (`docs/perf/androidtv-frame-map.md`); the silhouette bakes
  were ~330 ms of an Android cold build.

**Why painting in curvilinear (s, lat) is safe NOW when it was the original
sin:** the old objection — track space bends the stamp around corners, and the
per-triangle kinks of the interpolated uv0 field ripple through a SHARP edge —
was an edge phenomenon. The layer's stamp was a soft field laid at ~8 texels/u
of arclength, so a kink of a few cm was sub-texel against the penumbra; and
each stamp is rasterized as a **warped quad in two slices** (six
`deckFoot`-projected points), so the bending error lives inside a half-stamp,
second order, not first-order axis-aligned smear.

**AND BOTH PREMISES OF THAT SAFETY ARGUMENT HAVE SINCE BEEN SPENT.** The
flicker fix took the layer to 16 texels/u, so a kink that was sub-texel is
resolvable; and the edge is now a NARROW THRESHOLD on a smooth field rather
than a penumbra, which is precisely the "SHARP edge" this paragraph says the
kinks ripple through. A cornering ripple was reported after both landed. It is
NOT the slicing (measured, above), and the density test cannot speak to it —
dropping the density doubles the ordinary edge crawl and swamps the thing
under test. **A `project()`-placed stamp was the named escalation**: the raster
writes at the ANALYTIC surface's (s, lat) while the shader reads through uv0's
per-triangle interpolation, and the disagreement between the two is exactly
the kink. It was built and removed, never shown to buy anything on the glass
or on the box (where its windowed ring scan per probe costs CPU); the edge band
below is what answered the creases.

**THE BLOB'S SHAPE IS A ROUNDED RECT FITTED TO EACH MODEL'S OWN OUTLINE —
four corners for every car, by the user's eye** (`ttp/car_footprint.h`,
executed on every leg by the `carfootprint` ctest). The model's triangles are
projected top-down and rasterized on the CPU out of the same GLB bytes the
merged draw groups already decode — no parse, no GPU pass, no readback — and
the fit (fill across, fill along, corner radius) is one pass over that
coverage. The raster evaluates the rect in CLOSED FORM: the cheap arm, half
the channel's CPU on the Android box against sampling the outline mask, and
still per car — Rumble's fit comes out visibly rounder, the monster's bigger.
The raster builds the rect's evaluator once per triangle and skips the texels
its `zero()` proves empty, the overscan margin past the ramp.

> **The fitted k-GON was built, shown, and NOT chosen**, and the outline MASK
> arm (sampling the model's blurred outline, sixteen reads a texel) went with
> it; git history has both. A convex hull simplified to a few edges
> (containment-preserving, symmetrized, two lobes split at the silhouette's
> waist so a body pinch reads) carries taper the rect cannot — and still read
> WORSE on the model that mattered: Rumble is an open-wheeler, a narrow rear
> body with a GAP to wheels that poke past it, and any lobeless closed-form
> shape renders that as lumps.

**The AABB cannot do this job, which is the whole reason the footprint exists.**
All four roster cars measure x ±0.26 to ±0.28 by z ±0.438 and are
origin-centred, so a shape sized off the bounding box is the SAME shape for
every one of them. Only the outline inside the box differs.

**Two things about it are easy to get silently wrong, and both are pinned.**
The mask's v axis runs tail (0) to NOSE (1) and the kit models nose toward −Z
under the renderer's base `FLIP`, so the bake negates both axes; on a
left-right symmetric car the v sign is the only one that can show, and the
ctest pins it. And the outline must be captured while the asset is at its
PARSE POSE — `getWorldTransform` answers where the car IS, so a capture taken
mid-race measures a car hundreds of units from the mask's frame and rasterizes
to nothing at all. That is why the outline is captured and fitted once, at
load (`bakeCarFootprint`), which refuses a capture whose extent does not
straddle the origin rather than let it fail silently.

**THE BLOB COSTS ON BOTH SIDES, and the GPU half is the bigger one.** The table
below is the CPU half and still holds; the "GPU flat, the tap is free" reading it
was first written around does NOT, and was taken when the blob was the FAR-car
path beside a masked loop rather than the only shadow in the frame. Paired
against a zero coverage cap — which gates the tap block while the raster and
upload keep running — 4P/1080 prices the tap block at 4.4 ms of GPU against
1.9 ms of CPU raster and upload. Spend on either half, and price the one you
are spending on. The frame map carries that split and the three levers
measured dead inside it.

Measured on the Android reference box at four players by ablating the
channel (`TTP_DEBUG_NO_DECAL_BLOB`), every arm with the same build:

| arm | CPU ms |
|---|---|
| channel off | 3.28 |
| 8 / 128, dirty-rect upload | 4.19 |
| 16 / 256, dirty-rect upload | 5.32 |
| 16 / 256, whole-level upload | 6.17 |

So the channel is ~2.0 ms of frame thread as it ships, and BOTH halves scale
with density: the raster because a denser stamp covers more texels, the upload
because there are more bytes. **The GPU half does not scale with it** — shrinking
the layer sixteenfold moved the tap by nothing measurable, which is why density
is a CPU lever only. Only the Android box can price this channel (it is free
on a desktop GPU), and each arm is a build.

**THE LAYER'S DENSITY IS THE FLICKER, and it is the first thing to reach for.**
The raster re-lands every stamp at a new sub-texel offset each frame, so a
coarse grid cannot hold an edge still. At the original 8 texels/u by 128 rows a
car's whole stamp was **15 by 10 texels** and its edge boiled — measured against
a shadow-off baseline over identical gated sim frames, it carried about twice
the temporal energy the masked silhouette put in the same band. 16 / 256 doubles
the grid each way, cuts that excess by ~53-73% depending on the scene, and lands
at or below the silhouette it replaced; it is the shipped default. **It
saturates there**: the width clamps against the driver's texture ceiling, so
24/384 measured only a few points better for twice the bytes again. The cost is
the whole-level upload, 0.38 -> 1.53 MB a frame — still ONE event, and GPU time
on the web reference did not move (2.02 -> 1.80 ms p50 at four players, three
interleaved reps). **The Android box is the one that has not been re-measured.**

**THE EDGE IS A WIDE MEDIUM BAND (0.2..0.8 of peak) OVER A WIDE FIELD (blur
0.07), CUT IN THE SHADER — and both cliffs beside it are measured.** The road
mesh interpolates uv0 linearly per triangle, so the tap's read coordinate has
a GRADIENT JUMP at every triangle edge. A flat stored value reads flat through
any kink, but wherever the stored field has gradient the kink prints as a
Mach-band crease — under a yawed car, diagonal bands through the shadow
(user-reported twice). **A readback of the layer is what pinned this to the
read side**: the stored stamp was clean while the screen banded. With NO cut
the whole wide skirt is gradient and the creases get their maximum area
(that arm shipped for a day and failed the user's eye); with the die-cut's NARROW threshold (0.39..0.61) the slope
facets on the bilinear texel grid and amplifies the raster's per-frame
sub-texel re-landing into edge boil (that arm failed the user's eye first).
The wide band is the middle: `remapLo` clips the faint tail where the creases
have the most area, `remapHi` saturating at mid-field keeps the visible
transition tight, and the ~1.7 slope is far from the die-cut's ~4.5. Density
does not move the creases (16 → 32 texels/u, same picture) and neither did a
`project()`-placed stamp — a write-side placement cannot remove a read-map
derivative jump. **The band must stay non-empty** (`remapHi > remapLo`): a
degenerate smoothstep is UB.

The die-cut era's measurements survive and still bound the knobs:

- Cutting in the RASTER measured 44% MORE edge flicker than cutting in the
  shader on identical gated frames (the finished alpha quantises the edge to
  the texel grid before the tap ever sees it). The shader side ships.
- Sweeping `blur` under the cut: 0.030 cut edge flicker 25%, 0.040 43%,
  0.060 61%. The old reason to stop at 0.040 — the outline mask's wheel lobes
  blurring away — left with the rounded rect, which has no lobes to lose.
- The rect's stored ramp is sized from `blur`; at half a texel it measured
  30% WORSE than the outline masks, so the ramp floor is the texel footprint
  and the target is the blur width.

`remapLo`/`remapHi` are FRACTIONS OF THE PEAK ALPHA, scaled by `ao` on the way
to the uniform, so a change of opacity cannot slide the shadow under its own
threshold.

**How far the SHAPE is worth pushing is also a measured question.** At the
original density the four models' masks differed by at most ~0.07 mean coverage
and two of them (Dash and Carve) by 0.001 — these are boxy toy cars whose wheels
sit near flush with the body. An outline dilation and the density are what
convert what difference there is into something visible, and reading the mask
back was the only way to tell a shape that is WRONG from one that is right and
merely too small to read. Reading the LAYER back is what pinned the creases to
the read side: diagnose a shadow artifact from the bytes the raster wrote,
never from pixels, and add such a readback for the job rather than guess.

> **Measuring flicker here has one trap that wasted a run.** Scoring arms one
> after another lets the car drive somewhere else in between, and the scenery it
> passes swamps the effect — a first pass ranked SHADOWS-OFF as the flickeriest
> arm. Pump ONE gated frame, then re-render it once per arm (`display.frame()`
> draws, the session advances the sim, so a repaint costs no sim time) and score
> each arm down its own sequence. Cars hidden, rubber wiped.

**When a decal channel draws nothing, suspect the TEXTURE CONTENT first**:
stage tints cannot reach inside a sample. The standing case: a TRANSLUCENT
bake into an R8 array layer rendered ZERO coverage on the PowerVR driver while
logging success, so every car fell back to a generic shape that no screenshot
gate could tell from the real one. A bake that renders nothing has to SAY so.

Each car still pushes a READBACK-ONLY entry into the decal list
(`DeckDecal::car`, folded into no chunk): `ttp_display_debug_decals`, the warp
bench and the conform diagnostics read the car rows off `mDeckDecalsLast`.

**Downgrading far cars into the PROFILE arrays is a dead end already
MEASURED** (2026-08-18, spectate-7 view): profile-list ellipses for the far
cars need the profile arrays widened past 8, and the widening alone cost
+1.1 ms p50 under a pack — more than the masked entries it saved. The
declared-size law holds under load; the carShadow layer is the design that
added NO declared bytes.

**The stamp is laid from six `deckFoot`-projected points a frame, never from a
track-space reach.** The reach a stamp needs in track space is an ARCLENGTH —
which the stamp's world half-diagonal is not. The deck's iso-arclength lines
FAN on a bend, so off the centreline a world step spans `R/(R−lat)` more
arclength; a constant reach closed INSIDE the stamp and cut its nose or tail along a ring plane, with the cut
sliding as the car swept the corner. Measured over real races: it cut on 2.2%
of car-frames on cloverleaf and 1.7% on sidewinder, worst shortfall 2.4×, and
**0% on skyline** — which is the tell, because skyline rolls rather than
bends. The six points are laid from the plane the car SITS on (the best fit
through its four wheel contacts, which the seating has already paid for), and
the raster draws them directly — they ARE the warped quad.

**Reasoning shortcut worth keeping:** through a FLAT bend the deck is a plane and
the stamp's world projection is rigid, so its track-space extent is the only
thing that can reshape it. A stamp that changes shape through a flat bend is a
placement bug, and that alone finds it without any pixel work.

**The shader path is the ONLY path — do not bring back overlay meshes.** A
separate mesh over the deck cannot be flat: road and decal are two chord
approximations of one curve at different vertex spacings, so one always pokes
through and a lift epsilon is the whole (tunable, auditable, wrong-on-some-
track) budget. A lifted sheet also tints whatever crosses its plane: ALL
blended geometry draws after ALL opaque geometry (Filament's pass bits outrank
renderable priority), so a shadow sheet painted the bottom slice of every tyre
from a low camera. The conformed-mesh fallbacks (for a shell served no
`vroad.filamat`) were deleted 2026-07-31 along with the JS audit that kept
their duplicated art honest; a shell without `vroad.filamat` now simply draws
a bare deck, and materials are a mandatory step in the shells ledger anyway.
**What is still a mesh:** the hazard cones and wet-floor signs — they are not
flat.

**`View::BlendMode::TRANSLUCENT` is a COMPOSITING mode, not a "keep the
target" switch.** It composites the view's draws as premultiplied SRC_OVER,
overriding the material's own blending — vskid's additive stamps silently
became replace, so a light mark punched a hole through a dark one and every
stamp's zero-ink skirt gnawed its neighbour's edge into a sawtooth. Target
preservation comes from `Renderer::ClearOptions` (clear=false,
discard=false) at the render call, never from the blend mode.
> **AND IT IS PRICED IN WHOLE SURFACES.** Compositing a view means Filament
> renders it into a full-surface intermediate and blends the lot on, however
> few pixels the view actually draws. The 2D cell overlay asked for it and paid
> **4.2-4.5 ms of a 16.68 ms budget at 3840x2160** for a few thousand pixels of
> divider and steer bar: the largest single item in a 4-player Apple TV frame,
> larger than the entire game world. Ablating the quads instead measured the
> same, so the drawing was never the cost. A view that is LAST in its frame
> needs no compositing mode at all — Filament clears colour only for the first
> view into a target, so an OPAQUE view blends its own transparent materials
> onto what is already there. Read a view's blend mode before pricing anything
> inside it.

**Skid marks are the same road-shader paint, accumulated — on the CPU.** The
transient decals above are re-packed every frame; rubber instead lands in a
per-track R8 texture in track space (u = s / lap, v = lat across the deck)
that `vroad` samples with one extra tap. **Paint, then rubber, then decals** is
the compositing order, and it is a rule about what a thing IS: a repair or a
pad is the deck's own surface so ink lays over it, while a shadow, an aura or
an oil film is laid ON the deck so it composites over the ink the way it would
over bare asphalt. Get it wrong and an opaque stamp blanks the ink under its
own footprint — the racing line comes out with clean holes punched in it,
which is what the pads and repairs used to do from the decal side. (The deck's
lane dashes never had the bug, being vertex colour on the road mesh, already
under the tap.) The oil slick stays a decal deliberately — a spill, and on the
beach standing water, sits on top — and its full opacity is what stopped lines
and wear ghosting through it.

The writer is a CPU rasterizer, not a pass: each committed trail segment's
4-column quad is filled top-left-rule into a persistent CPU buffer
(`mSkidPix`, additive with saturation — `vskid.mat`'s old blend) and the
frame's dirty rects upload by `setImage`, on EVERY frame that commits a stamp
and before `beginFrame`, so a mark is drawn the frame it is laid. A ~30 Hz
throttle stood here and was removed once measured: it lagged the trail's
visible head behind the tyre by latency times road speed and bought nothing
back (`renderSkids` carries the sweep, `shells/androidtv/CLAUDE.md` the
numbers — the layer's cost is the tap and the raster, never the event rate).
The ribbon is anchored a rolling radius AHEAD of the wheel node, at the
tyre's leading ground contact: a head can only ever lag, since additive
permanent ink cannot be drawn ahead and rewritten, so the lead puts the
`SKID_SEG_MIN` commit distance under the tyre where it cannot be seen.
Ink is permanent until the
race-restart wipe — a memset + full re-upload — because a decay pass was the
layer's whole recurring GPU cost (megatexels of read-modify-write) and
permanence is also how a real toy track behaves; the racing line rubbers in
over a race. Do not reintroduce a per-frame fullscreen pass here without
measuring on the weakest shell — the **mip refresh is throttled to ~7 Hz**
for exactly that reason. The layer needs that chain: the tap is trilinear
because the deck ahead minifies an 8k-wide texture (`mMaxTextureDim` is a
chosen ceiling on every platform, clamped down by the driver and never up — no
surface queries a device maximum), and a no-mip LINEAR tap
scintillated every mark across the whole deck. Its throttle rides `mTime`,
which restarts per scene, so its timestamp is per-scene state and is cleared
with the texture. There is no pool, no budget and no lift; unbounded marks
cost fixed memory. The tap reads the uv RAW — an upload has no per-backend
flip, and the suite audit (`tests/render-target-uv.test.js`) classifies the
sampler — and the stamper keeps the texture's outer lat rows empty, which is
what parks the kerbs' and underside's out-of-band v on zero ink.

**Why the rubber layer is not a render target, and must not become one.**
The GPU-stamped shape (additive `vskid.mat` quads into an attached RT) was
device-broken in every arrangement on the A10X Apple TV, each tripping a
different below-the-API behaviour that neither GL nor the tvOS simulator
reproduces: a persistent target's texture SAMPLED AS ZERO unless its binding
churned every frame; a transient-per-pass target lost the accumulated ink
(only the newest stamps survived); a draw-less clear rode a cullable pass and
never landed; and the persistent+rebind+zeroed shape still artifacted in real
races (stray patches, a faint full-track line). The 2026-08-14 source audit
of the pinned Filament fork closed the case: the Metal backend emits
IDENTICAL command streams for the transient and persistent arrangements
(same `MTLTexture` for write and read, fresh `MTLRenderPassDescriptor` per
pass, load/store from the pass params either way), so the differences were
inside the driver and no RT arrangement at our layer can be trusted for an
ACCUMULATING attachment on that device. Uploads are the path every other
texture in the game already proves out, and dropping the stamp pass also
dropped a full-size TBDR load/store per stamp frame. The bakes stay
transient-RT and are fine — they repaint whole layers, so an undefined start
is harmless there.

## The build budget: a bake is a fact about the TRACK

A scene build is not a frame, and on the slowest shipping box it is worth more
than a hundred of them. Measured on the Android reference device: a full
`ttp_display_build` is ~700 ms, and **the sun bake is 520 ms of it** — the depth
render, the 81-tap ESM blur and the ground's visibility decode, all of which end
in `flushAndWait`. Everything else together (the shell's asset provisioning, the
kit field, the world builders, the ground sheet, the gantry) is the remaining
tenth. Split it before optimising it; `bakeShadowMap` and `buildTrackScene` each
log their own phases.

**TIME A REBUILD, NOT A LAUNCH.** The first build of a process pays costs no
later build with the same models pays again — pipeline creation, the kit's
shared texture decode — so a cold first build (which is what a launch log gives
you) overstates what a rebuild costs. `cars` and `props+rig` are where it shows;
read their split off a second build in the same process.

The consequence for anything tempted to KEEP parsed assets across a scene, the
way the sun bake and the shadow fits are kept: what such a cache buys is the
warm rebuild's phase, never the cold build's. Price it against that. The
one-time half is a process warm-up problem, not a resource pool's. Filament's
`backend.vulkan.enable_pipeline_cache_prewarming` is unavailable on the reference
box (no `VK_EXT_vertex_input_dynamic_state`), so the effect pools are drawn once
before the race (`warmEffectPipelines`) and the compiled pipelines outlive the
process instead: the fork's Vulkan backend keeps its VkPipelineCache in the
platform blob cache, which `TtpRenderer::init` points at a file the Android shell
names (`setPipelineCacheFile`).

**Car bodies ARE kept** (`mBodyPool`) on exactly that trade; the rest of the
gltfio assets are still dropped by `releaseScene` while the shadow fits keyed off
those same models survive, so the asymmetry is closed for the bodies and open for
everything else. **PARKING RESTORES NOTHING** — a parked body is out of the scene
and otherwise untouched, so it still wears the last frame's pose while
`loadCarAsset` measures its wheel seats on the stated assumption that the asset is
exactly as parsed. `takeAsset` therefore hands one back at its snapshotted parse
pose (`mBodyRest`), and anything else added to the reuse path has to ask the same
question: what would a fresh `createAsset` have guaranteed?

**The casters are the STATIC scene, and cars cast nothing** (`setVisibleLayers`
0x02). So the bake is a function of the track and its biome, and a rebuild that
changed only the FIELD — a phone joining, a launch dressing the grid it was
already previewing — reproduces a bit-identical map. The maps therefore outlive
`releaseScene`, keyed by what the shim says the scene is OF, and the same
rebuild costs ~200 ms instead of ~700.

Keep a thing by what it varies on — the per-model shadow fits and the body
pool follow the same rule. If you add anything
to the bake, ask what it varies on first: a caster that depends on the ROSTER
would silently invalidate the whole scheme, and the failure mode is a scene lit
by the last track's shadows. The key is CONSUMED per build, so a new
`buildScene` caller that sets none falls through to a real bake rather than
inheriting somebody else's claim.

**A READBACK CANNOT BE WAITED ON INSIDE THE BUILD, and one backend enforces it.**
A GL readback's completion is executed from `OpenGLDriver::tick()`, which
`FRenderer::endFrame()` calls and `flushAndWait()` does not — so however many
times a build flushes, the callback cannot land, and in a browser a task cannot
wait on the GPU at all. Metal and Vulkan fire theirs from command-buffer
completion and land on the first pass.

**SO THE BAKES DO NOT READ BACK AT ALL ANY MORE**, and the cheapest way to
satisfy this rule turned out to be to stop needing it. The road's baked vertex
light was the one thing in a build that pulled a map to the CPU: it took the
whole 1024² ESM back as RGBA float (16 MB) so `fillRoadLight` could evaluate the
decode per vertex, and around that sat a deferred-read apparatus — a parked
read, a build serial to drop a stale one, graves for buffers a driver might
still be writing, a frame-beat collector, and a per-track cache of the finished
fill. Visibility is a GPU bake now (`vroadvis.mat`), so the fill is arithmetic
over the road's own normals and all of it is gone.

Keep the failure it cost, though, because it is the shape of the whole class:
the old code dropped an unfinished read on the floor, so the WEB road kept the
unshadowed fill from build — a deck lit but taking no cast shadow, for the whole
session, with nothing to say so. It looked right because the GROUND was
unaffected: its visibility map is a shader tap that never goes near a readback.
**A receiver that is fed by a readback and one that is fed by a tap will
disagree silently**, and the disagreement is invisible unless you look at the
two side by side.

**EVERY blob works that way now** (`stageBlob` / `collectStagedBlobs`). A blob
that is worth keeping between runs snapshots everything that is not a readback —
headers, matrices, the row-flip convention — and parks the reads;
the frame beat finishes it. The snapshot is what makes a deferred finish honest:
the earlier synchronous `exportBake` read `mBakedKey` and `mShadowFromWorld` at
export time, so anything that finished a parked read later would have paired one
build's pixels with another build's matrices. Two consequences worth keeping in
mind here:

- **A texture a staged read is still writing into may not be destroyed.**
  `replaceShadowMaps` sends it to `mTexGraves` instead, drained once the read
  lands. The old pool keyed parked reads by (texture, layer) and retired one whose
  stamp had moved — but the ESM texture is destroyed and reallocated on every
  non-reused bake, so a read nobody was asking about matched nothing, was never
  retired, and held a 16 MB buffer and a RenderTarget over freed storage for the
  life of the page.
- **A read that never lands is LEAKED on purpose** at teardown: the driver may
  still hold a pointer into that buffer and there is no tick left to fire the
  callback.

**AN IMPORT OWNS ITS PIXELS**, which is the same argument pointing the other way.
A `PixelBufferDescriptor` over the caller's bytes is a use-after-free that a
`flushAndWait` does not cover: the shells free their offer buffer when the ABI
call returns, and a shell that reuses one address per offer then has every layer
uploading whichever blob was offered LAST, read at its own header's offset — a
shifted copy of the wrong blob rather than nothing at all, which reads on
screen as one thing winning everywhere and not as a lifetime bug. Copy on the
way in; what a shell promises is only that the bytes are valid for the call.

## The per-frame budget

A steady-state race frame is one `ttp_display_frame(dt)`, one
`ttp_audio_frame(now)` and a packed cell-rects read. The rest of the HUD is a
low-rate poll: **nothing in the DOM is written per frame.**

**Anything tempted onto the per-frame path needs to actually CHANGE per frame.**

**THE DECK IS THE FRAME.** `ttp_display_debug_features` drops one group of
renderables at a time and `scripts/perf-features.mjs` reads the GPU timer around
each arm; run it before optimising anything here, because the answer is lopsided
enough to make most instincts wrong:

- The **road** drawn alone costs more than the whole scene does. Terrain, set
  dressing, the sky's billboards and the item/effect pools together come to
  roughly the empty-scene floor — they are not where a millisecond is.
- **Cars are a net NEGATIVE.** They cost about a fifth of the frame to draw and
  occlude several times that much deck, so hiding them makes the frame slower.
  The corollary is the useful one: on this scene, anything that keeps a road
  fragment from being shaded is worth more than anything that makes a car
  cheaper.
- Inside the road, the **decal loop** is the channel worth watching; the rubber
  tap, the deck paint and the sun's one shadow tap are each a fraction of it.

So the deck's fragment shader is the budget, and the way to spend less of it is
to shade fewer of its fragments — not to trim triangles elsewhere.

**That ranking is the WEB's, and a weak mobile GPU adds a second term to it.**
On a PowerVR GE9215 the same sweep splits the cost into `fixed + per-megapixel`
rather than per-megapixel alone, and the fixed part is about half the 60 Hz
budget on its own — no render scale reaches under it. Three things follow. The
`ttp_display_gpu_ms` timer is REAL on that backend (the emscripten compiled-out
case is the one this tree already documents), so an arm can be measured directly
there instead of inferred from a vsync-quantised cadence; an arm must be run at a
PINNED render scale, at TWO resolutions, or the fixed and fill halves cannot be
told apart; and the fixed half is measured by pinning the scale near the floor,
where fill is a fraction of a millisecond and every group's marginal is almost
pure fixed cost. `shells/androidtv/CLAUDE.md` carries that device's numbers and
the scripts that take them.

**The fixed half is the scene being SUBMITTED, and it has no single hot spot.**
On that device it is not the road's vertex count, not its draw-call count, not
the cell overlay pass and not the present — each was ablated and each moved
under half a millisecond. It is spread across the deck, the terrain and the set
dressing, so the way to spend less of it is to submit less, not to find the one
thing at fault. Do not go looking for that one thing again; the arms are in the
shell's file.

**AND IT IS PER-VERTEX SHADING RATHER THAN VERTEX COUNT.** "Submit less" is
right and "submit fewer vertices" is not, because a vertex's price depends
entirely on what its vertex shader does. Measured at four players on the
reference Android box, splitting the dressing ablation in two
(`ttp_display_dress_keep` / `ttp_display_dress_sheets`, which exist for this):

| removed | verts/frame | resolution-independent |
|---|---|---|
| the merged kit COPIES | 40k | **1.1 ms** |
| the SHEETS (boulders, clutter, landmarks, signs) | **88k** | **~0.0 ms** |

Twice the vertices, none of the cost. The copies are the kit's LIT models; the
sheets carry no normals at all. The deck agrees from the third direction: its
shading is baked into custom0 by `fillRoadLight`, and cutting 54k deck vertices
bought 0.4 ms where these 40k bought 1.1.

**So the ORDER of a mesh's triangles is a cost too.** A tiler shades a vertex
once per batch of primitives that reference it, and the deck as generated
re-shaded both new corners of every triangle. `buildMesh` therefore reorders
every OPAQUE range and its far form for vertex reuse (`reorderForVertexReuse`,
meshoptimizer), within the range only so each renderable keeps its own
triangles, box and far form; the instanced kit prims are reordered too. **Nothing may depend
on the triangle order inside an opaque range after build**; a blended mesh
keeps its order, because it composites in it.

Three consequences, and the first two have each been paid for once:

- **A FAR-PLANE CUT BUYS NOTHING HERE, and the reason is the content.** The
  fog saturates at `RACE_FOG_FAR` and the scenery is authored to end where the
  fog does, so sweeping the far plane from 600 u to 100 u moves the count by two
  per cent. What a cell submits is INSTANCE COUNT, and it is the 4P heavy
  seconds that pay for it (below), not the median.
- **CUTTING GEOMETRY OFF THE DECK OR THE TERRAIN IS NOT WORTH THE COMPLEXITY —
  ON THE RUN'S MEDIAN.** Chunking both for cullability and pairing the deck
  with a coarse twin cut the frame's submitted vertices by a quarter and
  measured **−0.4 ms of GPU against +0.55 ms of frame thread** — the renderable
  count is not free either. Both were built, measured and reverted; the history
  has them. **The exception is a FAR FORM per cell, and it is why the median
  lied** (`LodRange`, `chooseLods`): the 4P frame is not one picture but two,
  the clean seconds and a few a lap where every cell looks across the whole
  circuit and submits most of it, sub-pixel detail and all. A renderable
  listed there owns a second index range over its OWN vertices that strays at
  most `err` world units, and each cell draws it past the distance where `err`
  covers `kLodPx` pixels OF THAT CELL, so a big cell pushes the swap out on
  its own and one player at 1080 barely sees it. The deck's is a ribbon of one
  quad per run of same-coloured rings under a 0.08 u chord (2026-09-02, about
  a third off those seconds); every static unlit mesh that opts in with a
  `simplify` (the baked kit runs, the landmarks) gets a `meshopt_simplify` of
  each renderable at build. A coarse kit model is not an asset anybody would
  author, but a simplifier finds the 0.2 u of it nobody sees at 26 u. The
  flowers do NOT opt in: simplifying them strips the petals, which are the
  point of them. It runs at EVERY cell count (the user's call); a gate of
  zero was priced and declined; the frame map has every arm. Read a 4P lever
  on the heavy seconds (`perf-race --timeline`), never the run.
- **What DOES pay is making a vertex cheaper to shade.** The props are static,
  the sun is static, and they were lit from scratch every frame in every cell.
  The static SHEETS (hills, boulders, clutter, landmarks, gantry) now fold the
  matte light into their vertex colours at build and draw unlit
  (`Mesh::bakeLight`, `bakedMatteLight` — `fillRoadLight`'s argument one
  level out), which the frame map prices at about 0.6 ms of the 4P heavy
  seconds. A mesh that MOVES after build cannot take it (the light would
  ride the transform), which is why it is opt-in. The one visible
  difference is a vertex bake's own: a coarse smooth-normal cylinder is lit
  between its vertices rather than per pixel. The kit COPIES are baked the
  same way through their merged groups (below, "A STATIC dressing group is
  BAKED"). What still lights live: the cars, the cone pool, the windmill,
  the plane, the rockets, and the sun-shadow RECEIVERS (structures, berms,
  ground), whose visibility tap is the shadow you see. Lighting the kit
  material per VERTEX for what is left on it (the cars, the cones) measured a
  null even after the dressing was baked out of it: the fragment shade it
  removes is worth ~0.5 ms, and the vertex light it adds costs the same.

**AND NONE OF IT REACHES 60 AT FOUR PLAYERS.** Sweeping the render scale down to
a twenty-fifth of native pixels still leaves that frame at 19.8 ms against a
16.7 ms budget: the resolution-independent floor is ~19 ms, of which ALL
geometry is about 4. The rest scales with CELLS, not with pixels or vertices.
Four players WAS a 30 fps mode; since the deck's far ribbon the reference box
holds a 4P race at 540@60 with a handful of dropped frames in half an hour
(`ttp/render_scale.h` has why 540 is the floor at every cell count), and a
millisecond saved there buys resolution rather than frames.
> **A PASS PRICED AT ONE PANEL SIZE SAYS NOTHING ABOUT ANOTHER.** That same
> cell overlay pass, at the Apple TV's nine times the pixels, was the whole
> reason a 4-way split missed 60 Hz — and what it cost was its VIEW's blend
> mode rather than anything it drew. The `BlendMode::TRANSLUCENT` note above is
> the one place that law is written.

**THE KIT'S COPIES ARE MERGED DRAWS** (TtpRenderer.h, "Merged draw groups").
The car field and the per-copy dressing are re-issued as one renderable per
distinct MESH with an explicit `InstanceBuffer` — automatic instancing cannot
batch them (depth-bucketed and winding-split), and on the submission-bound TV
frame the draw count IS the cost. The rules that keep it honest:

- **The gltfio originals stay the source of truth.** Their entities remain,
  transforms and all; the groups MIRROR node world transforms per frame
  (`updateMergedTransforms`), so the wheel spin/steer/travel, the monster
  park, the ghost swap and `debugHideCars` are inherited, never
  re-implemented. The monster swap is PER CELL, so `renderCells` re-mirrors
  while one is on.
- **Geometry comes from the same GLB bytes the shell provided**, through
  `ttp/glb_mesh.h` (header-inline; the `glbmesh` ctest executes it on every
  leg), and materials are SHARED from the originals'. A model the reader
  cannot fully decode keeps drawing exactly as gltfio loaded it — the
  fallback is whole-model, never a partial merge.
- **A merged group culls as ONE box**, trading per-copy frustum culling for
  the draw count — the right trade on a submission-bound frame. Teardown
  order matters twice: `destroyCarSlot` kills the groups BEFORE the asset
  whose material instances they share, and `releaseScene` destroys them
  while the source entities are still alive to be handed back.
- **A STATIC dressing group is BAKED, not instanced** (`MergedGroup::baked`,
  `bakeMergedRun`): the copies expand into one world-space mesh whose vertex
  colour is texture x live baseColorFactor x matte light, drawn by the plain
  unlit material — same draw count, no instance buffer, no tangents, no
  sampler, nothing lit at draw time. Expanded because the light depends on
  each copy's own rotation. The texture half comes from
  `generated/kit_colors.h` (scripts/gen-kit-colors.mjs, gated by
  codegen-freshness): the kit's atlas is flat swatches with a linear ramp
  and every kit UV triangle is a point or a vertical line inside one, so a
  vertex sample interpolates back to the picture — verified by pixel diff.
  The FACTOR is read back from the live instance, never the GLB, because the
  biome recolours untextured models by overriding it. A model the table does
  not know (its bytes hash misses) keeps the instanced, live-lit draw. The
  cars and the cone pool are dynamic and stay instanced.

The item-box fade twins stay unmerged on purpose: they hold PER-INSTANCE
materials, the one thing a shared instanced draw cannot express.

**WHAT THE MERGE IS WORTH, measured honestly** (interleaved via
`TTP_DEBUG_NO_MERGE` on one launch, Google TV Streamer, 4P at pinned 540):
−104 draws/frame moved the GPU **median** not at all — the median frame is
fill/vertex-bound there, and the "per-draw submission cost" earlier group
ablations suggested was mostly those groups' own fill. What it does buy, in
every interleaved pair: the WORST frame (−2 to −3.5 ms of GPU), the delivered
rate (+1–2 fps — on a vsync display the tail is what quantizes into fps), and
~0.25 ms of renderer CPU. Do not expect draw-count cuts alone to move a GPU
median on THAT class of box again; expect them to steady it.
> **That is a fact about the device, not about draw cuts.** The same commit moves
> the Apple TV's 4P native median **14.2 -> 13.67 ms** (three reps, spread 0.05,
> against a pre-merge arm just as tight), and its worst window 18.3 -> ~17.0. A
> frame whose cost is submission answers a draw cut; one whose cost is fill does
> not. Price it per platform.

**ON THE APPLE TV THE DECK IS THE FRAME TOO, and harder than anywhere.** At four
players and native 4K the road's own fragment shader is the largest content item
in the frame — ablating it moves the median about a fifth — and the channels
inside it rank in the same order as the web's above. An older reading
that the content there was noise came from comparing FULL against a mask of 0,
which is not a floor (`ttp_display.h` says why); every group must be priced
against whatever shades the pixels it hides.

**And the deck's cost is the ONE OR TWO CHUNKS UNDER THE CAMERAS.** A per-chunk
gate on the two full-width track-space taps was built, proven to disarm ~85% of
chunks, and moved the median by nothing — so ~90% of a full-deck tap is paid by
the near chunks, which are exactly where the pack always is and where rubber
always is. **That refutes the whole family of "gate the deck by region"**:
distance LOD, fog culling, a cheap material variant for far chunks. The far deck
is already nearly free. Spend on the near deck's shader or spend nothing.

**A PASS COSTS ITS ATTACHMENT, NOT THE AREA IT DRAWS — and that still does not
buy anything.** One cell drawing the same pixels costs measurably more into a 4K
attachment than into a quarter-size one, which makes per-cell quarter targets
look like the answer to a 4-way split's extra passes. Measured end to end it is
a **net loss**: pointing all four cell views at a quarter-size offscreen at
identical fill wins ~0.4 ms, and the one full-surface composite needed to put
the four images back on screen costs five times that — `--aa 1` is exactly that
shape, and the antialias switch below is where it is priced. Do not
rebuild this.

> **PRICE A PASS BY RUNNING IT, NEVER BY FITTING ONE.** A per-pass "fixed cost"
> term fitted over a resolution sweep predicted both of the above as wins. The
> cell-overlay pass — full surface, almost nothing drawn, measurably free —
> is the standing counter-example that there is no such term.

**AN sRGB SURFACE IN PLACE OF THE GRADE LUT WAS BUILT, PRICED ON ALL THREE
PLATFORMS, AND DECLINED** (2026-09-02): an sRGB swapchain where Filament
grants one, an sRGB CAMetalLayer on tvOS, every material writing linear
through the grade's bypass global, the fog, sky and overlay colours
converted to match, the web keeping the LUT. Pixel-correct everywhere. A
null on the Android box (the store-side encode costs what the three taps
cost on that GPU) and about a millisecond of the Apple TV's 4P native 4K
frame. The rule this tree hunts by is "improves the Android box, the weakest
device" — a tvOS-only millisecond does not qualify, so it is not in the
tree; the session's history has the patch if that rule ever changes. Priced
beside it and dead on its own numbers: a two-drawable CAMetalLayer (one
present interval less input latency, by construction) dropped 29 frames a
second at 4P 4K — one frame of queue cannot absorb a 13 ms frame's spikes.

**The full-screen antialias pass is a switch** (`ttp_display_antialias`), and
turning it off removes the offscreen scene buffer with it, so the saving is both
that buffer's store and vpresent's read. **Both TV shells turn it off**; the web
keeps it.

**AND THE BUFFER IS THE COST, NOT THE FILTER.** Ablating vpresent's fragment to a
straight passthrough — same target, same pass, no FXAA taps — splits the switch's
saving on the Apple TV at 4 players / native 4K into **~0.3 ms of filter and the
rest plumbing** (0.31 / 1.99 as measured, and the filter is the half that does
not scale with the buffer). The SWITCH's total was re-taken on the current tree
as **~2.4 ms** (three interleaved pairs, 2.26 / 2.53 / 2.37); an earlier reading
of 1.8 does not reproduce, and single pairs here are worth about +/-0.2 ms.

Two things follow, and both are the opposite of the instinct:
there is **no cheaper AA to write** here (a shorter span, a tighter early-out, a
3-tap filter all chase that 0.3), so the decision is BINARY; and what the custom
shader buys is the PASS COUNT rather than the arithmetic — see vpresent.mat.

**THE FOG IS OURS, PER VERTEX** (`ttp_fog.inc`), and the view's fog is switched
off. Filament's costs a SHADER VARIANT rather than an exponential — a cubemap
sampler for the sky-colour option and a pow() for sun inscattering, both behind
uniform branches this scene never takes — and it measured EIGHTEEN milliseconds
of a 79 ms frame on the reference Android GPU. Filament's own cheap path
(`linearFog : true`) recovers barely a third of that, which is what identifies
the variant rather than the maths as the cost. Written per fragment ours still
cost 11.5 ms; per vertex it costs about 3.
> **A per-vertex term needs vertices.** The flat ground sheet was four corners
> spanning ±400, all past the fog cut-off, so the whole ground read "no fog"
> until it was subdivided. Anything large, flat and fogged has to carry enough
> vertices to interpolate between — see the ground sheet's STEP.

**One transcendental over a full-screen surface is about 3 ms on that GPU**, and
that is the unit to think in when reading any of the numbers above. It is also
why the sRGB encode cannot be made cheaper by approximation: a 2-sqrt fit
accurate to one 8-bit code measured no faster than the `pow` it replaced.

**A dynamically-indexed uniform ARRAY costs whether or not the loop runs**, and
it costs by DECLARED SIZE. Over a frozen single-player race at 1280x720 on the
reference Android GPU, vroad's one mixed 32-entry list (seven arrays, 3584
bytes) put the frame at 25.9 ms; the same seven arrays at 16 put it at 18.9 and
at 8 at 17.6. Ablating the LOOP with the arrays still declared was worth a
fraction of that — it is the declaration, not the iterations.

**Collected by taking the car shadows OUT of the list.** A profile stamp is a
shape the shader evaluates and needs three vec4s, so the material declares 8
of them (`kMaxProfileDeckDecals`); the car shadows, which needed more fields per
entry, are the carShadow tap instead and declare no array at all. **Raising the
cap is measurable in the frame**; `tests/road-decal-caps.test.js` holds the
material's array sizes and each loop's clamp to the C++ constants.

**MOVE THE SMOOTH HALF OF THE SHADING TO THE VERTEX STAGE.** The same trade the
fog made, for the same reason, and worth 7.5 ms of a 720p frame on that GPU: the
deck's light — ambient and N·L — is smooth over metres, while its COLOUR
(asphalt, lines, dashes, paint, rubber, decals) is the detailed half.
`ttpMatteAmbient` / `ttpMatteSunTerm` are the split (`ttp_shade.inc`); for the
ROAD both are frame-invariant (static sun, static deck), so `fillRoadLight`
evaluates them once per track into a baked per-vertex attribute — custom0 as
`(ambient.rgb, NoL)`, riding the fog varying's `.yzw` and a second varying. The
fragment keeps its multiply, the per-frame vertex stage is left with a move, and
the road stopped emitting tangents: nothing reads its normal at draw time.

**A caller must own the sampling rate, IN BOTH AXES.** This is only sound where
the mesh is finer than the shadow's own softness. For the road that was checked
ALONG the track — 0.48 u rings against a 0.6 u penumbra — and not ACROSS it,
where the 16-point cross-section puts deck-level columns at lat ±half,
±(half−gap), ±(half−gap−lw) and ±dashW/2 and leaves **~2.15 u of each lane with
no vertex at all**. So VISIBILITY could never be a vertex term: a cast shadow
narrower than that is interpolated into a 2.15 u ramp or lost. Measured on
skyline's barrel roll, where the rolled deck turns edge-on and its shadow closes
to ~2 u: the fully-dark core went 1.62 u (per fragment) to 0.66 u (per vertex),
and the per-vertex answer barely moved as the roll turned, being pinned to the
columns rather than following the caster. It is a **track-space bake** now
(`vroadvis.mat`), one R8 tap in vroad.

Two receivers, two bakes, and the reason they differ is worth keeping: the
ground sheet's 20 u step is too coarse the same way, so vground samples per
fragment from `visMap` — but that map is on the LIGHT's own grid (vvis.mat
renders the real ground through the ESM's light camera), which works only
because the ground is single-valued under a near-overhead sun. The road is not:
a barrel roll sits directly over the deck it shadows and a loop has two
arclengths at one `(x, z)`, so its map has to be in TRACK space.

**And with visibility off the CPU, the road-light READBACK is gone.** It existed
only so `fillRoadLight` could evaluate the ESM decode per vertex, and on GL a
readback completes from `OpenGLDriver::tick()` — which `endFrame()` calls and
`flushAndWait()` does not — so an entire deferred-read apparatus (parked reads,
build serials, stale-drop, graves, a per-track cache of the finished fill)
existed to finish it on a later frame. `fillRoadLight` reads no map now and
completes inside the build on every backend.

`public/display/render/Display.js` is the browser's whole edge of this; for
measuring frame cost see `public/display/CLAUDE.md`.
