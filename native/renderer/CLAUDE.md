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

The car's contact shadow is a **HYBRID, by distance**: `kMaxMaskedDeckDecals`
(4) cars within `kShadowLodFar` of an active camera draw true baked-silhouette
MASKED stamps (the per-fragment uniform loop), and everyone else rides **one
bilinear tap of the carShadow layer** — a small track-space R8 texture the
renderer CPU-rasterizes per frame (the rubber layer's idiom — same (s, lat)
mapping, same lat span, so vroad's tap reuses the rubber uv) and re-uploads
WHOLE, as one `setImage`, into a **ping-pong pair** so the upload never
respecifies the texture the driver is reading (`uploadCarShadow` has the
argument; the skid layer's stall history is why). Between the bands the two
representations crossfade with complementary alphas, statelessly, so it cannot
pop; and the near pick is a RANK gate, so the masked cap can only downgrade a
shadow to the texture blob, never delete it. The texture path is what retired
the old ALL-masked loop's cost — ~5 ms of the realistic 720p frame under a
pack, after every arithmetic-level cut inside it measured zero — and the masked
near band is what the texture layer's ~8 texels/u cannot carry: the
silhouette's car-shape under your own car.

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

**The TEXTURE path's silhouette source is the CPU superellipse for every car**
— at the layer's density a baked per-car silhouette is indistinguishable from
it, it needs no per-scene readback, and being symmetric it cannot be mirrored
by a handedness mistake. `bakeSilhouette` RUNS on the shipping blob: it feeds
the NEAR cars' masked stamps, where the true car-shape does read. **An
airborne-anchor theory is a dead end already walked.**

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
frame's dirty rects upload by `setImage`. Ink is permanent until the
race-restart wipe — a memset + full re-upload — because a decay pass was the
layer's whole recurring GPU cost (megatexels of read-modify-write) and
permanence is also how a real toy track behaves; the racing line rubbers in
over a race. Do not reintroduce a per-frame fullscreen pass here without
measuring on the weakest shell — the **mip refresh is throttled to ~7 Hz**
for exactly that reason. The layer needs that chain: the tap is trilinear
because the deck ahead minifies an 8k-to-16k-wide texture (the width is the
shell-reported GL_MAX_TEXTURE_SIZE, and only the WEB surface reports one — see
mMaxTextureDim), and a no-mip LINEAR tap
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

**The full-screen antialias pass is a switch** (`ttp_display_antialias`), and
turning it off removes the offscreen scene buffer with it, so the saving is both
that buffer's store and vpresent's read. It is on everywhere except Android TV.

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
deck's light — ambient, N·L and the baked sun map's visibility — is smooth over
metres, while its COLOUR (asphalt, lines, dashes, paint, rubber, decals) is the
detailed half. `ttpMatteLight` is the split (`ttp_shade.inc`); for the ROAD every input to it
is frame-invariant (static sun, static deck, cars cast blob decals), so
`fillRoadLight` evaluates the identical function once per track — after
`bakeShadowMap`, reading the ESM back through `Renderer::readPixels` — into a
baked per-vertex attribute (custom0) that rides the fog varying's unused
`.yzw`. The fragment keeps its multiply, the per-frame vertex stage is left
with a move, and the road stopped emitting tangents: nothing reads its normal
at draw time any more. **A caller must own the sampling rate**: this is only sound where
the mesh is finer than the shadow's own softness, which the road's 0.48 u rings
are against a 0.6 u penumbra. The ground sheet's 20 u step is NOT — so vground
samples per fragment, but from `visMap`, the ground's own sun-visibility BAKE
(vvis.mat renders the real ground through the ESM's light camera once per
track, in `bakeShadowMap`): one R8 tap instead of the full ESM decode.

`public/display/render/Display.js` is the browser's whole edge of this; for
measuring frame cost see `public/display/CLAUDE.md`.
