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
5. A texture sample inside the decal loop must be `textureLod`, never
   `texture()`: the loop's per-fragment `continue` rejects make the flow
   NON-UNIFORM, where an implicit-derivative sample is undefined behaviour.
   **The rule is not the loop's, it is the whole renderer's** — the same
   mistake was live in `sunVisibility` (early returns, then a `texture()`) and
   in vpresent's FXAA span taps (a contrast early-out, then four of them). Both
   are `textureLod` now. Every map involved is single-level and bound with a
   non-mipmap filter, so LOD 0 is exactly what an implicit sample would pick.
   On ANGLE's Metal backend the shipped `texture()` read as the car shadow
   intermittently rendering nothing for a few frames — a flicker that
   vanished under every instrumented variant of the shader, because any
   reshape moved the UB. Every CPU-side input was verified sane at the
   failing moment before the sample was suspected; start there next time.

**One box gates each loop.** The entries a chunk carries CLUSTER — they are
mostly the cars, and the cars are in a pack — while the chunk is tens of metres
of deck, so without a gate the road's biggest, nearest fragments each ran every
entry's reject to draw nothing. `profBounds` and `maskBounds` are each channel's
union of its entries' own reject windows, so they are exact rather than
conservative: a fragment one rejects would have rejected each entry in turn.
**Build them from the same two bounds the loops test** — `rect.zw` for a
profile stamp, the MEASURED reach in the CPU entry's `wfwd`/`wright` w slots
for a masked one — or the box clips a stamp the loop would have drawn.

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
COMPOSITING order instead — statics, then auras, then shadows and blobs over
both, so an aura lands over the slick it crosses and a shadow stays visible
through an aura. A decal mix REPLACES what is under it, so **an aura may not
composite over a contact shadow**: that was the mesh era's order and its
premise was ADDITIVE blending. Note the coupling — because the order is also
the cap priority, a full chunk drops the shadows before the auras.

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
**DIRTY RECT** — the stamps' own, merged — into a **ping-pong pair** so the
upload never respecifies the texture the driver is reading (`uploadCarShadow`
has the argument; the skid layer's stall history is why). **The pair is what
makes the dirty rects three frames deep**: a texture is written every OTHER
frame, so it was last correct two frames ago, and missing one frame's rects
leaves each texture holding the other's stale stamps — the shadow strobes
between two positions. `uploadWhole` is the A/B arm that priced it.

`CarShadowTuning::mode` is the switch and `kShadowModeBlob` is what ships, so
the masked per-fragment loop draws NOTHING in an ordinary frame: every entry
goes out `texrot.w == 2`, readback-only, and `foldToChunk` never makes one
fold-visible. What that buys is the whole decal channel on the weakest box —
~7 ms of a 4P/1080 Android frame, priced below — and it cannot pop, because the
blob is what the crossfade always degraded to anyway. **The two other modes are
A/B arms** (`/shadow-lab.html` drives them) and nothing on the shipping path
selects one: `kShadowModeSilhouette` puts every car the pick reaches on the
masked loop with no distance fade, and `kShadowModeHybrid` restores the
distance LOD described below.

> **The hybrid, for when the trade is re-argued.** `kMaxMaskedDeckDecals` (4)
> cars within `kShadowLodFar` of an active camera drew true baked-silhouette
> MASKED stamps and everyone else rode the blob, the two crossfading with
> complementary alphas between the bands, statelessly, so it could not pop; the
> near pick was a RANK gate, so the masked cap could only downgrade a shadow to
> the blob, never delete it. Its near band existed for the one thing the layer's
> ~8 texels/u could not carry — the silhouette's car-shape under your own car —
> and the per-car footprint below is what replaced that argument.

**WHICH four is a PER-VIEW round robin, and that is a correctness rule, not a
tuning knob.** Each camera takes its first choice before any camera takes its
second, so round one is every player's own car. One global pool ranked by
distance to the nearest camera is starvable the moment the screen splits: four
cameras competing for four slots have no headroom, and a bot drafting any
player sits closer to that player's eye than the player's own car does at
`CHASE_DIST` — so it took the slot and some *other* player's own car fell to
the blob, with no crossfade, because the rank gate jumps `lodT` straight to 1.
Draining one view's whole allowance before starting the next has the same
disease with a different victim (cameras 0 and 1 eat everything). The invariant
worth keeping: **no camera may be starved by another's picks.**

**Eight masked entries are NOT affordable in a split, and the ablation that
suggests otherwise is a trap.** Ablating the whole decal channel at 4 players /
720p saves only ~0.55 ms, which reads like room to dress the whole field.
Measured instead (2026-08-20, three interleaved reps, no overlap between arms):
raising the cap to 8 cost **+4.96 ms p50** (30.98 -> 35.93, fps 28 -> 25, and
it crosses a vsync slot so the rate steps rather than slides), while the same
build at 1 player measured **zero** against [4] (17.47 vs 17.28). So the cost
is neither linear in live entries nor about DECLARED size — it is the per-chunk
**bounds box**: four masked cars in a split sit in four separate chunks with a
tight box each, while eight put two in one chunk with a union spanning both, so
the fragments that ENTER the loop multiply as well as the iterations each then
runs. Raising the cap needs a tighter per-entry reject first, not a bigger
budget. (Untested and the only honest open question: whether it fits at the
real 4-player operating point of 540p + hz30, where the budget doubles and the
fill is ~56% — do not assume it from the 720p number.)

**The masked stamps WERE the decal channel's whole cost on the Android box,
and a separate pass could not collect it.** Past tense since 2026-08-27: the
rank gate at the end of this paragraph retired the loop everywhere, and a
re-decomposition then found the cost had moved wholesale onto the layer that
replaced it, not vanished — see `docs/perf/androidtv-frame-map.md`. Keep reading
anyway: the refuted escapes below are the durable half, and the retired loop is
still what the plan doc's Phase 5 numbers describe. Decomposed under Vulkan at 4P
(`TTP_DEBUG_NO_DECAL_*`, the sub-channel knobs; readings and method in
`docs/perf/androidtv-4p-plan.md` Phase 5): the four own-car silhouette stamps
are ~7 ms of a 1080 frame while the profile loop, the statics and the far
blob tap each price at or under the bracket — and the two probe bits split
the mechanism into the loop's own fragments (~2/3) plus a residue every
fragment of a stamp-carrying chunk pays merely for `maskCount > 0` (~1/3).
The per-frame uniform rewrites are FREE (MASK_COUNT0 proves it). **The
depth-EQUAL stamp pass is the refuted escape**: re-emitting the stamp's ring
range of the road's own buffers as a transparent depth-EQUAL renderable
renders correctly and measures a null — shading those fragments costs the
same wherever they are issued, so do not rebuild it, and do not file the
masked cost as "pass structure" again. The third probe
(MASK_FLAT: the tap answers a constant, the maths runs in full) prices the
FETCH at a fraction of a millisecond, and the NEAR-SHADOW CASCADE — the full
texture-space escape, silhouettes CPU-rastered into a high-density windowed
atlas and the loop body reduced to one clamped tap — was BUILT, rendered
correctly, and bought only ~0.8 ms: the executed cost is the per-entry
DYNAMICALLY-INDEXED UNIFORM READS in divergent flow, the declared-size law
seen from the execution side. Nothing spellable inside a per-entry loop
collects it; analytic shapes, texture formats and resolutions are all refuted
with it. The one lever that converts is the rank gate itself — a LOOK trade the
user took, first at four cells and then everywhere: `CarShadowTuning::mode`
ships as `kShadowModeBlob`, so no frame draws a masked stamp at any cell count.
The channel's cost did NOT go with it, and 4P no longer locks 768x432@60 — it
passes through that rung and cycles below it. Both are re-measured in the frame
map; do not quote the lock from here. What made it a trade
worth taking rather than a loss was the per-car FOOTPRINT above — the near
band's whole argument was the car-shape under your own car, and the blob
carries one now.

**Why painting in curvilinear (s, lat) is safe NOW when it was the original
sin:** the old objection — track space bends the stamp around corners, and the
per-triangle kinks of the interpolated uv0 field ripple through a SHARP edge —
was an edge phenomenon. The layer's stamp is the pre-blurred superellipse laid
at ~8 texels/u of arclength, so a kink of a few cm is sub-texel against the
penumbra; and each stamp is rasterized as a **warped quad in two slices**
(six `deckFoot`-projected points — the cull-window probes, kept instead of
folded to maxes), so the bending error lives inside a half-stamp, second
order, not first-order axis-aligned smear. If the shimmer ever returns, the
escalation is `project()`-projected corners (the settle-point the skids use),
not a return to the uniform loop.

**AND BOTH PREMISES OF THAT SAFETY ARGUMENT HAVE SINCE BEEN SPENT.** The
flicker fix took the layer to 16 texels/u, so a kink that was sub-texel is
resolvable; and the edge is now a NARROW THRESHOLD on a smooth field rather
than a penumbra, which is precisely the "SHARP edge" this paragraph says the
kinks ripple through. A cornering ripple was reported after both landed. It is
NOT the slicing (measured, above), and the density test cannot speak to it —
dropping the density doubles the ordinary edge crawl and swamps the thing
under test. **The open question is whether the stamp should be placed by
`project()` rather than `deckFoot`**: the raster writes at the ANALYTIC
surface's (s, lat) while the shader reads through uv0's per-triangle
interpolation, and the disagreement between the two is exactly the kink. That
is the named escalation and it is unbuilt.

**THE BLOB'S SHAPE IS A ROUNDED RECT FITTED TO EACH MODEL'S OWN OUTLINE —
four corners for every car, by the user's eye** (`ttp/car_footprint.h`,
executed on every leg by the `carfootprint` ctest). The model's triangles are
projected top-down and rasterized on the CPU out of the same GLB bytes the
merged draw groups already decode — no parse, no GPU pass, no readback — and
the fit (fill across, fill along, corner radius) is one pass over that
coverage. The raster evaluates the rect in CLOSED FORM: the cheap arm, half
the channel's CPU on the Android box against sampling the outline mask, and
still per car — Rumble's fit comes out visibly rounder, the monster's bigger.
`analyticCoverage` is the ONE evaluator both the raster and the mask-card
readback go through, so the lab cannot show a shape the deck is not drawing.

> **The fitted k-GON (`kShadowShapePoly`) was built, shown, and NOT chosen —
> it survives as a lab arm beside the masks.** A convex hull simplified to
> `polyEdges` edges (containment-preserving, symmetrized, two lobes split at
> the silhouette's waist so a body pinch reads) carries taper the rect
> cannot — and still read WORSE on the model that mattered: Rumble is an
> open-wheeler, a narrow rear body with a GAP to wheels that poke past it,
> and any lobeless closed-form shape renders that as lumps. Silhouette
> fidelity past "grounded, per-car, four corners" is the outline MASK's job
> (`kShadowShapeCar`), at its measured cost.

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
to nothing at all. That is why `mCarOutlines` keeps the captured geometry and
every re-bake rasterizes from the copy; `bakeCarFootprint` refuses a capture
whose extent does not straddle the origin rather than let it fail silently.

**THE BLOB COSTS ON BOTH SIDES, and the GPU half is the bigger one.** The table
below is the CPU half and still holds; the "GPU flat, the tap is free" reading it
was first written around does NOT, and was taken when the blob was the FAR-car
path beside a masked loop rather than the only shadow in the frame. Paired
against `cap:0` — which gates the tap block while the raster and upload keep
running — 4P/1080 prices the tap block at 4.4 ms of GPU against 1.9 ms of CPU
raster and upload. Spend on either half, and price the one you are spending on.
The frame map carries that split and the three levers measured dead inside it.

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
is a CPU lever only. `debug.ttp.shadow` on that box takes the tuning as partial
JSON, which is how every row above was taken; `/shadow-lab.html` cannot answer this question
because the same channel is free on a desktop GPU.

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
(user-reported twice). **The layer readback is what pins this to the read
side**: the stored stamp is clean while the screen bands — diagnose there
first, never from pixels. With NO cut the whole wide skirt is gradient and
the creases get their maximum area (that arm shipped for a day and failed the
user's eye); with the die-cut's NARROW threshold (0.39..0.61) the slope
facets on the bilinear texel grid and amplifies the raster's per-frame
sub-texel re-landing into edge boil (that arm failed the user's eye first).
The wide band is the middle: `remapLo` clips the faint tail where the creases
have the most area, `remapHi` saturating at mid-field keeps the visible
transition tight, and the ~1.7 slope is far from the die-cut's ~4.5. Density
does not move the creases (16 → 32 texels/u, same picture) and neither does
`stampProject` — a write-side placement cannot remove a read-map derivative
jump, which is also why it stays a knob and off. An EMPTY band
(`remapHi <= remapLo`) means no remap anywhere — one invariant, honoured by
`shadowRemapParam` (which forces the shader's raw-tap route; a degenerate
smoothstep is UB) and by the raster's cut alike; it is the lab's cut-off arm.

The die-cut era's measurements survive and still bound the knobs:

- Cutting in the RASTER measured 44% MORE edge flicker than cutting in the
  shader on identical gated frames (the finished alpha quantises the edge to
  the texel grid before the tap ever sees it). `remapInShader` keeps both
  arms; the shader side ships.
- Sweeping `blur` under the cut: 0.030 cut edge flicker 25%, 0.040 43%,
  0.060 61%. The old reason to stop at 0.040 — the outline mask's wheel lobes
  blurring away — left with the rounded rect, which has no lobes to lose.
- The analytic shape's stored ramp is sized from `blur`; at half a texel it
  measured 30% WORSE than the masks, so the ramp floor is the texel footprint
  and the target is the blur width.

`remapLo`/`remapHi` are FRACTIONS OF THE PEAK ALPHA, scaled by `ao` on the way
to the uniform, so an arm dragging opacity cannot slide the shadow under its
own threshold.

**How far the SHAPE is worth pushing is also a measured question.** At the
original density the four models' masks differed by at most ~0.07 mean coverage
and two of them (Dash and Carve) by 0.001 — these are boxy toy cars whose wheels
sit near flush with the body. `grow` and the density are the knobs that convert
what difference there is into something visible; `/shadow-lab.html` is where
they are dragged, it prints the stamp's texel count beside them, and
`ttp_display_shadow_mask_json` is how the baked mask is read back — the only way
to tell a shape that is WRONG from one that is right and merely too small to
read.

> **Measuring flicker here has one trap that wasted a run.** Scoring arms one
> after another lets the car drive somewhere else in between, and the scenery it
> passes swamps the effect — a first pass ranked SHADOWS-OFF as the flickeriest
> arm. Pump ONE gated frame, then re-render it once per arm (`display.frame()`
> draws, the session advances the sim, so a repaint costs no sim time) and score
> each arm down its own sequence. Cars hidden, rubber wiped.

`bakeSilhouette` (the GPU array-layer bake) still RUNS: it feeds the masked
stamps the two A/B modes draw. **An airborne-anchor theory is a dead end
already walked.**

**The silhouette store is keyed by MODEL, and a bake outlives the scene.** A
layer belongs to the GLB's bytes (`claimMaskLayer` hashes them), not to a grid
slot: the field is eight cars over the kit's four models, so a per-slot store
baked the same outline twice and spent a layer on each copy. Two players in one
model at different liveries share correctly because coverage rides ALPHA, which
carries no colour. Since a bake is then a fact about the kit rather than about
this race, `releaseScene` keeps the baked bits and a cup's races pay the bakes
once — which also deletes the window where a re-dressed slot showed the generic
oval until its rebake landed. `kMaskLayerModels` re-types a count `protocol.js`
owns, so `tests/mask-layer-models.test.js` holds it to `CAR_MODELS`; a fifth
model added without raising it would fall back to the oval in silence.

**A bake that renders nothing now SAYS so.** Setting the baked bit
unconditionally made the one failure mode invisible: an empty layer with its
bit set draws no shadow at all, and a CLEAR bit draws a plausible oval, so
neither a screenshot gate nor a success log separates the three states. The
R8 experiment in `ensureDecalMaskArray` put every car there on the PowerVR
driver while logging success. `bakeSilhouette` reads back a central patch of
its own target — the ortho camera frames the model's aabb with overscan, so the
body always covers the middle — and leaves the bit clear when no coverage
landed. **When a decal channel draws nothing, suspect the TEXTURE CONTENT
first**: stage tints cannot reach inside a sample.

**`roadHasMaskLoop()` / `roadHasCarShadow()` are INDEPENDENT capability
probes on the served blob, not a shipped-vs-fallback switch**: the current
`vroad.filamat` declares BOTH halves, and each path keys on its own probe, so
a blob carrying only one half still draws that half. Two cases go ALL-masked
on a current blob, both without per-car LOD ranking: no carShadow texture (the
pair only builds where the rubber layer does), and the forced debug mask layer
(`renderCars` has the split — overviews and the no-views fallback stay on the
texture path instead, so every car keeps a shadow under the masked [4] cap).
The CPU-side masked entries are pushed EITHER WAY —
`ttp_display_debug_decals`, the warp bench and the conform diagnostics read
them off `mDeckDecalsLast`, texture path included.

**Downgrading far cars into the PROFILE arrays is a dead end already
MEASURED** (2026-08-18, spectate-7 view): profile-list ellipses for the far
cars need the profile arrays widened past 8, and the widening alone cost
+1.1 ms p50 under a pack — more than the masked entries it saved. The
declared-size law holds under load; the shipped hybrid is itself a distance
LOD, and its far half — the carShadow layer — is the design that added NO
declared bytes.

> The anchor was the track frame's tangent plane at the car's spot until
> 2026-08-02. On a flat or purely banked deck the two planes are identical; where
> the deck crests or twists they are not, and a rigid stamp projected from the
> wrong one foreshortens across its own footprint — stretching on a crest,
> shearing on a twist. The seating above has already paid for the probes, so the
> better plane is free.

**The stamp's track-space window is MEASURED per frame, never a constant.**
The reach a stamp needs in track space is an ARCLENGTH — which the stamp's
world half-diagonal is not. The deck's iso-arclength lines FAN on a bend, so
off the centreline a world step spans `R/(R−lat)` more arclength; the constant
that stood here closed INSIDE the stamp and cut its nose or tail along a ring
plane, with the cut sliding as the car swept the corner. Measured over real
races: it cut on 2.2% of car-frames on cloverleaf and 1.7% on sidewinder,
worst shortfall 2.4×, and **0% on skyline** — which is the tell, because
skyline rolls rather than bends. The measurement is six `deckFoot`-projected
points per car per frame; the TEXTURE path rasterizes those points directly
(they ARE the warped quad), while the MASKED path folds their maxes: the
halves ride the w slots of the CPU entry's `wfwd`/`wright` (DeckDecal), read
by `foldToChunk` and packed into the shader's `maskRect.zw` (the axes land in
`maskWFwd`/`maskWRight`) by `uploadDeckDecals` — the one site that keeps the
cull and the fold in step.

**Reasoning shortcut worth keeping:** through a FLAT bend the deck is a plane and
the stamp's world projection is rigid, so the cull is the only thing that can
reshape it. That alone points at the window without any pixel work.

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
bakeSilhouette keeps TRANSLUCENT because alpha-compositing is exactly what
a mask bake wants.
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

**`cars` IS MOSTLY A ONE-TIME COST, AND THE SPLIT ONLY SHOWS IF YOU REBUILD.**
On the Android reference box (Google TV Streamer, Vulkan) the `cars` phase is
~405 ms on the FIRST build of a process and **~28 ms on every build after it**,
with the same models both times. Whatever that 14x is — pipeline creation, the
kit's shared texture decode — it is paid once per process, not per build, so
reading it off a cold first build (which is what a launch log gives you) badly
overstates what a rebuild costs. `props+rig` behaves the same way, 67 ms then 20.

The consequence for anything tempted to KEEP parsed assets across a scene, the
way the sun bake and the silhouette layers are kept: what such a cache buys is
the ~28 ms, never the ~405. Price it against that. The one-time half is a process
warm-up problem and belongs with
`backend.vulkan.enable_pipeline_cache_prewarming`, not with a resource pool.

**Car bodies ARE kept** (`mBodyPool`) on exactly that trade; the rest of the
gltfio assets are still dropped by `releaseScene` while the mask layers keyed off
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

This is the same argument the silhouette layers already won ("a bake is a fact
about the kit rather than about this race"), one level up. If you add anything
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
shifted copy of the wrong silhouette rather than nothing at all, which reads on
screen as one car's shadow winning and not as a lifetime bug. Copy on the way in;
what a shell promises is only that the bytes are valid for the call.

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

Three consequences, and the first two have each been paid for once:

- **A DISTANCE LOD BUYS NOTHING HERE, and the reason is the content.** The fog
  saturates at `RACE_FOG_FAR` and the scenery is authored to end where the fog
  does, so sweeping the far plane from 600 u to 100 u moves the count by two per
  cent. There is no far field to grade. Nor is there detail to remove: the whole
  kit is 20,033 vertices and 9,524 triangles, a palm is 190 of them, so a
  "simpler model" is not an asset anybody can author. What the 126k dressing
  vertices a frame are is INSTANCE COUNT.
- **CUTTING GEOMETRY OFF THE DECK OR THE TERRAIN IS NOT WORTH THE COMPLEXITY —
  ON THE RUN'S MEDIAN.** Chunking both for cullability and pairing the deck
  with a coarse twin cut the frame's submitted vertices by a quarter and
  measured **−0.4 ms of GPU against +0.55 ms of frame thread** — the renderable
  count is not free either. Both were built, measured and reverted; the history
  has them. **The exception is the deck's FAR RIBBON, and it is why the median
  lied** (`RoadChunk`, `chooseDeckLod`, 2026-09-02): the 4P frame is not one
  picture but two — nine seconds a lap of clean 60 and eight of every cell
  looking down the straight at the whole deck, where the fine ribbon is
  thousands of sub-pixel triangles a cell. A second index buffer over the
  road's OWN vertices, one quad per run of same-coloured rings under a 0.08 u
  chord, swapped in per cell past the distance where that chord would cover
  `kDeckLodChordPx` pixels, takes about a third off those seconds on the
  Android box — and moves the median by little, which is exactly what the
  twin measured. It runs at EVERY cell count (the user's call); the gate is
  pixel-derived, so a big cell simply pushes it out. A gate of zero (the
  whole deck on the ribbon) was priced and declined; the frame map's
  2026-09-02 section has every arm. Read a 4P lever on the heavy seconds
  (`perf-race --timeline`), never the run.
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
  ground), whose visibility tap is the shadow you see.

**AND NONE OF IT REACHES 60 AT FOUR PLAYERS.** Sweeping the render scale down to
a twenty-fifth of native pixels still leaves that frame at 19.8 ms against a
16.7 ms budget: the resolution-independent floor is ~19 ms, of which ALL
geometry is about 4. The rest scales with CELLS, not with pixels or vertices.
Four players WAS a 30 fps mode; since the deck's far ribbon and the
render-scale retreat fixes of 2026-09-02 the reference box runs a 4P race at
60 fps for all but a few seconds a lap (`docs/perf/androidtv-frame-map.md`),
and a millisecond saved there buys resolution rather than frames.
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

**Collected by SPLITTING the list by kind** (`kMaxMaskedDeckDecals` /
`kMaxProfileDeckDecals`). A profile stamp is a shape the shader evaluates and
needs three vec4s; a masked stamp is a baked silhouette through a rigid world
projection and needs four — and since the hybrid shadow LOD the masked arrays
hold only the NEAR cars, so the material declares 8 profile + 4 masked. The
compositing order stays structural (profiles, then the shadow tap, then the
masked stamps over both) rather than a packing convention. **Raising either
cap is measurable in the frame**; `tests/road-decal-caps.test.js`
holds the material's array sizes and each loop's clamp to the C++ constants.

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
