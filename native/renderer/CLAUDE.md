# native/renderer/ — the Filament renderer

`runtime/ttp_display.h` drives it: per frame the shell calls
`ttp_display_frame(dt)` and C++ reads the live `Game` to build the renderer's
input in place. **Nothing about a car is ever serialized to JS and handed back.**

The platform-free half — camera rigs, fog profiles, the frame-input builder —
lives in `libttp-runtime` and is executed on every leg by `runtime_check` and
`frame_builder`. This directory needs the Filament SDK, so **no ctest compiles it**.

This file holds rules. What each one measured when it was decided is in
`docs/perf/androidtv-frame-map.md` (dated) or in a comment beside the code that
carries the value.

## What the renderer draws that a shell might expect to own

**Cell-anchored AND textless goes to the renderer; anything carrying type or
sticker chrome stays in the shell.** That is the steer bar and the cell dividers,
both pinned to a cell whose geometry is already C++. It keeps OUT the place/lap
ordinal, the name chip, the item slot, the FINISHED card and the reconnect QR.

**They take no unit from the shell.** The bar derives from its own cell and the
screen — a damped share of screen height, so a split shrinks it by the square root
of the share rather than proportionally. **Both terms are load-bearing:** drop the
screen term and the bar halves on a 4K panel (the devicePixelRatio trap); drop the
cell term and a split stops mattering. `BAR_SCALE` is the ONE knob. A shell porting
from a revision that called `ttp_display_ui_scale` deletes the call: a UI point
needs the panel's physical size and a viewing distance, and a TV has neither.

The dividers keep a canvas-relative weight, because their span is the canvas too.
The renderer's HUD block (`TTP_HUD_*` in `ttp_render.h`) is the only place the ink
and surface tokens are written down twice, held to `theme.css` by
`tests/design-tokens.test.js`. The surrounding cell chrome is shell-drawn in CSS
pixels and does **not** scale with the split — a known open question, not a rule.

## Framing: two grids, and only one is where the picture is

`ttp_grid_cell` tiles the RAW surface. `TtpRenderer::cellRect` fits that grid into
the `CELL_BASE_ASPECT`..`CELL_MAX_ASPECT` band **as one piece** and centres it, and
that is what the race cameras render into. Whatever the band trims is a bar — a
rendering decision, no part of the layout scoring.

**The band is a cell's rule and only a cell's.** An overview — lobby orbit,
gallery turntable, track preview, inspector cam — takes the surface ENTIRE and
says so with `TTP_FRAME_OVERVIEW`. The renderer cannot infer it, since one cell
and one overview are both `viewCount` 1. Getting it wrong letterboxes the lobby
*and* aims its projection at a shape it is not drawn into.

**Anything placing chrome wants `cellRectTopLeft`**, so the shell's chips and the
renderer's steer bar cannot land on different grids. This bites in ordinary play,
because the 2-player layout is stacked and gets fitted.

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
the sides. That is why the floor is hard (narrower would HIDE world) and the cap is
only taste. **The fov never scales by a height fraction** — three such fractions
shipped and each made the lens depend on the window or the layout, invisibly at
one player on 16:9. `frame_builder` gates it.

**A HELD field's chase rig follows the PICTURE, not the sim.** `ttp_display_hold`
parks the bodies at the pose they were last drawn at; the hold is taken at the END
of the finish flourish, and the burst that follows resolves every car still
running, so a rig fed the live car sails off and leaves the parked body behind.
The results board fades up over that held frame, so the discrepancy is on screen.
`frame_builder`'s held-camera case is the gate.

## The deck is a ruled surface, and the car sits on it

Every DECK point of the road's cross-section is at `y == 0` in the frame, so at
each arclength the drivable deck is a straight LINE across and the whole surface
is that line swept: `P(s, lat) = frameAt(s).pos + frameAt(s).lat * lat`. Across the
car there is nothing to fit; along it, where the deck twists, consecutive rulings
are SKEW, so NO rigid pose lands all four wheels. That residual is the WHEELS'
travel to absorb: the body takes the best-fit plane through the four contacts and
each wheel its own residual as a local-Y offset. A body fit that tries to absorb it
is the mistake.

- **The probe is an EVALUATION, not a search.** The sim hands its `(totalS, lat)`
  across in `TtpCarInput`, and `deckFoot` walks that seed to each wheel's foot by
  Gauss-Newton on the surface. Nothing picks a nearest triangle or ring, so
  nothing can HOP; a fit over `project()` probes was reverted for exactly that
  lean noise.
- **Nothing in the conform is damped.** A filter buys smoothness with lag, and
  lag on a hill drags the car behind its contract position. **If a filter ever
  looks necessary here again, the probe is what is wrong.**
- **`deckFoot`'s step clamp is not a tuning constant.** A lateral offset near a
  tight corner's own radius stalls the offset curve and an unclamped step
  "converges" onto another part of the circuit.
- **The check that can fail on lean** is the fitted normal's second difference
  against the CONTRACT normal's on the same frames — a real baseline, since the
  contract normal lerps the knot ups. Read both off `ttp_display_debug_decals`
  (`upJitter` beside `jitter`/`rawJitter`); `?scenario=warp` isolates one warp.

## Decals are shaded into the road, not laid over it

Flat on-deck decals are handed to `vroad.mat` as track-space rectangles and
painted by the road's own fragment shader, so a decal's fragment IS a road
fragment at the road's own depth: **no lift, no chord sag, no polygon offset, no
render order.** The road carries arclength in uv0, which is also why loops work.
`ttp_display_debug_decals` reads the packed floats back — use it rather than
inferring shader state from pixels. It covers the DECAL channel only; the paint
channel (below) is written straight to the chunk instances.

**Five things cost a debugging round each:**

1. Filament flips V by default and uv0 here is not an image coordinate, so
   `flipUV : false` — or every decal lands by the far kerb.
2. **The deck mask is a per-vertex FLAG, not a threshold on v.** Thresholds failed
   both ways (excluding real road where the track narrows, or clipping decals to
   a middle band). The section is a CLOSED ring, so track space is written only on
   strips with both endpoints at ground level, or the underside takes every decal.
3. A `MaterialInstance` from `sceneInstance()` is scene-scoped, so a member holding
   one must be nulled in `releaseStatic()`.
4. A per-frame decal centre must agree with **what the rasterizer computes from
   uv0** — the road's own ring polyline, the ring-plane blend, then the exact
   per-triangle interpolation, because uv0 kinks at every diagonal. Every cheaper
   approximation saw-toothed the shadow; `project()`'s comment has the ladder.
5. **A texture sample under NON-UNIFORM control flow must be `textureLod`,
   never `texture()`** — an implicit-derivative sample there is undefined
   behaviour, and the rule is the whole renderer's (vroad's car-shadow taps, the
   ESM decode in `ttp_sunvis.inc`, vpresent's FXAA span taps). Every map involved
   is single-level, so LOD 0 is what an implicit sample would pick. On ANGLE's
   Metal backend the UB read as a car shadow intermittently rendering nothing,
   and any instrumented reshape of the shader moved it; when CPU inputs check out
   at the failing moment, suspect the sample.

**One box gates the loop.** `profBounds` is the union of the entries' own reject
windows, so it is exact: a fragment it rejects would have rejected each entry in
turn. **Build it from the same bound the loop tests** (`rect.zw`), or the box clips
a stamp the loop would have drawn.

**Chevrons are SDFs**, so the pads move without an atlas. The apex must LEAD or
every chevron reads as a brake marking. A pad is **flat paint** — a radial
gradient reads as an emissive saucer. The static list is capped by
`kMaxStaticDeckDecals`, not the shader's per-chunk cap; the item boxes come first
in it, because the collect fade rewrites entry i's alpha in place. Their grid is
**a margin plus a packed run**, never one chevron per cell; the **stroke is a world
width** while the layout stays normalised (the frame is anisotropic), and the
rectangle's box height is derived from that stroke.

**The asphalt patches (`ttp/wear.h`) and the boost pads are the deck's own PAINT,
not decals**: their own channel, written once per track onto the road chunks,
composited BEFORE the rubber tap while every decal composites after. They carry
the decal layout and are painted by the same `paintStamp()`, so a pad cannot look
different for having changed sides.

**A chunk list that overflows its cap keeps the HEAD**, in both channels (one
`foldToChunk` folds and selects for each). Paint uses it as PRIORITY — pads first,
repairs after, so decoration falls off a dense chunk rather than a marker. The
decal list's order is COMPOSITING order — statics, then auras, then item blobs —
because a decal mix REPLACES what is under it; since order is also cap priority,
a full chunk drops the item blobs before the auras. The CAR shadows are not in the
list: they are the carShadow tap, composited BEFORE every decal so an aura lands
over its own car's shadow.

## The car contact shadow: one blob, one tap

**EVERY car's contact shadow is the BLOB — one bilinear tap of the carShadow
layer — at every cell count.** The layer is a small track-space R8 texture the
renderer CPU-rasterizes per frame (the rubber layer's idiom: same (s, lat)
mapping and lat span, so the tap reuses the rubber uv) and re-uploads by **DIRTY
RECT**, merged per frame, into a **ping-pong pair** on GL and Metal and **ONE
texture bound once** on Vulkan (`uploadCarShadow` has both arguments).

- **No per-frame path may re-point a road instance's sampler**: on Vulkan each
  re-point rebuilds every road instance's descriptor set.
- **The dirty rects are three frames deep** for the pair: a texture written every
  OTHER frame was last correct two frames ago, and a missed frame's rects strobe
  the shadow between two positions. Vulkan keeps the same history.
- Each car also pushes a READBACK-ONLY entry (`DeckDecal::car`, folded into no
  chunk) so `ttp_display_debug_decals` and the warp bench can read the car rows.

**The deck's layer reads sample a bare varying.** vroad's rubber, car-shadow and
sun-vis uvs are affine in uv0, so the VERTEX stage computes them (`layerUV`,
`visUV`) and each read is non-dependent — one the GPU can issue before the
fragment shader runs. A new deck-layer tap belongs in a varying too; arithmetic on
the uv in the fragment makes the read dependent again.

**The masked silhouette path was built, priced and deleted; git history has it,
and its probe bits are holes in `ttp_display.h` — do not hunt for them.** What it
measured is the durable half:

- **The cost was the per-entry DYNAMICALLY-INDEXED UNIFORM READS in divergent
  flow** — the declared-size law (below) seen from the execution side. Five
  escapes were built and refuted (`docs/perf/androidtv-4p-plan.md`, Phase 5):
  shading those fragments costs the same wherever they are issued, so do not
  file such a cost as "pass structure". Nothing spellable inside a per-entry
  loop collects it.
- **A per-chunk loop costs its BOUNDS BOX, not its entry count.** Two cars in one
  chunk multiply the fragments entering the loop as well as the iterations each
  runs, so raise a per-chunk cap only behind a tighter per-entry reject.
- **A budget shared by split-screen views must be a PER-VIEW round robin.** A
  global pool ranked by distance to the nearest camera starves some player's own
  car the moment a bot drafts another player.

**Track-space creases are a READ-side defect.** uv0 is interpolated linearly per
triangle, so wherever the stored field has gradient the kink prints as a crease.
A `project()`-placed stamp (a write-side fix) was built and bought nothing; the
remap band in `CarShadowTuning` is what answers it.

**THE BLOB'S SHAPE IS A ROUNDED RECT FITTED TO EACH MODEL'S OWN OUTLINE —
four corners for every car, by the user's eye** (`ttp/car_footprint.h`,
executed on every leg by the `carfootprint` ctest). The model's triangles are
projected top-down and rasterized on the CPU out of the same GLB bytes the
merged draw groups already decode — no parse, no GPU pass, no readback — and
the fit (fill across, fill along, corner radius) is one pass over that coverage.
The raster evaluates the rect in CLOSED FORM and skips the texels its `zero()`
proves empty. A fitted k-gon and an outline-mask arm were built and not chosen
(`CarShadowTuning`'s header says why).

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

**The blob costs on BOTH sides, and they move on different levers.** The GPU
half is the tap block; the CPU half is the raster and upload. Density (texels per
unit) scales the CPU half only. Price the half you are spending on — an arm with a
zero coverage cap (`CarShadowTuning::cap`) gates the tap while the raster and
upload keep running. Only the Android box can price this channel; it is free on a
desktop GPU.

**THE LAYER'S DENSITY IS THE FLICKER, and it is the first thing to reach for.**
The raster re-lands every stamp at a new sub-texel offset each frame, so a coarse
grid cannot hold an edge still. It saturates at the shipped density (the width
clamps against the driver's texture ceiling). The edge itself is a WIDE MEDIUM
BAND cut in the SHADER over a wide field; both cliffs beside it are measured, and
`CarShadowTuning` carries them. **The band must stay non-empty**
(`remapHi > remapLo`): a degenerate smoothstep is UB.

**Diagnose a shadow artifact from the BYTES, never from pixels.** Reading the
layer back is what pinned the creases to the read side, and reading the mask back
was the only way to tell a WRONG shape from one too small to read. Add such a
readback for the job rather than guess. **Measuring flicker** needs ONE gated
frame re-rendered once per arm (`display.frame()` draws without advancing the
sim), scored down each arm's own sequence, cars hidden, rubber wiped — scoring arms
one after another lets the scenery the car passes swamp the effect.

**When a decal channel draws nothing, suspect the TEXTURE CONTENT first**: stage
tints cannot reach inside a sample. A TRANSLUCENT bake into an R8 array layer once
rendered ZERO coverage on the PowerVR driver while logging success. A bake that
renders nothing has to SAY so.

**The stamp is laid from six `deckFoot`-projected points a frame, never from a
track-space reach.** The reach a stamp needs is an ARCLENGTH, and the deck's
iso-arclength lines FAN on a bend, so a constant reach cut the stamp's nose or tail
along a ring plane on bending tracks (and never on skyline, which rolls rather
than bends — the tell). The points are laid from the plane the car SITS on, and
they ARE the warped quad the raster draws. **Shortcut:** through a FLAT bend the
stamp's world projection is rigid, so a stamp that changes shape there is a
placement bug — no pixel work needed.

## The shader path, the views, and the rubber

**The shader path is the ONLY path — do not bring back overlay meshes.** Road and
decal are two chord approximations of one curve, so one always pokes through, and
ALL blended geometry draws after ALL opaque geometry (Filament's pass bits outrank
renderable priority), so a lifted sheet tints every tyre crossing its plane. A
shell without `vroad.filamat` draws a bare deck. **What is still a mesh:** the
hazard cones and wet-floor signs — they are not flat.

**`View::BlendMode::TRANSLUCENT` is a COMPOSITING mode, not a "keep the target"
switch.** It composites the view as premultiplied SRC_OVER, overriding the
material's own blending. Target preservation comes from `Renderer::ClearOptions`
(clear=false, discard=false), never from the blend mode.
> **AND IT IS PRICED IN WHOLE SURFACES.** Compositing a view renders it into a
> full-surface intermediate however few pixels it draws; the 2D cell overlay once
> paid more for that on a 4K Apple TV than the whole game world cost. A view LAST
> in its frame needs no compositing mode: Filament clears colour only for the
> first view into a target, so an OPAQUE view blends its own transparent
> materials onto what is there. Read a view's blend mode before pricing anything
> inside it — and price a pass at each panel size, since one priced at 1080 says
> nothing about 4K.

**Skid marks are the same road-shader paint, accumulated — on the CPU.** Rubber
lands in a per-track R8 texture in track space (u = s / lap, v = lat) that `vroad`
samples with one tap. **Paint, then rubber, then decals** is the compositing
order, and it is a rule about what a thing IS: a repair or a pad is the deck's own
surface so ink lays over it; a shadow, an aura or an oil film is laid ON the deck
so it composites over the ink. The oil slick stays a decal deliberately, at full
opacity so lines do not ghost through it.

- **The writer is a CPU rasterizer**: each committed segment's quad is filled
  top-left-rule into `mSkidPix` (additive, saturating) and the dirty rects upload
  on EVERY frame that commits a stamp, before `beginFrame`. A throttle lagged the
  trail's head behind the tyre and bought nothing (`renderSkids`).
- **The ribbon is anchored a rolling radius AHEAD of the wheel node**, because
  permanent additive ink cannot be drawn ahead and rewritten; the lead hides the
  `SKID_SEG_MIN` commit distance under the tyre.
- **Ink is permanent until the race-restart wipe.** A decay pass was the layer's
  whole recurring GPU cost. **Do not add a per-frame fullscreen pass here without
  measuring on the weakest shell** — the mip refresh is throttled for exactly
  that reason. The chain is needed (the deck ahead minifies an 8k-wide texture;
  `mMaxTextureDim` is a chosen ceiling, clamped down by the driver, never up);
  its throttle rides `mTime`, so its timestamp is cleared with the texture.
- **The tap reads the uv RAW** (an upload has no per-backend flip; the suite
  audit `tests/render-target-uv.test.js` classifies the sampler), and the stamper
  keeps the texture's outer lat rows empty, which parks the kerbs' and
  underside's out-of-band v on zero ink.

**The rubber layer is not a render target, and must not become one.** An
ACCUMULATING attachment was device-broken in every arrangement on the A10X Apple
TV — below the API, identical command streams from the Metal backend, invisible
to GL and the simulator. Uploads are the path every other texture already proves
out. The bakes stay transient-RT and are fine: they repaint whole layers.

## The static scene and the build

**THE STATIC SCENE IS A FUNCTION OF ITS KEY, and a build whose key matches the
resident one rebuilds only the FIELD.** The key is the shim's
(`track|biome|showcase|backend`, `bakeKeyFor`) plus the inputs the renderer
latches — shadows, the bench, the model variants, the kit field — whose setters
drop it on a change (`dropStaticKey`). The track, its dressing, the sky and the
sun bake stay up across a join, a leave, a race launch and a restart; `rebuildField`
rebuilds the cars and what is sized by them, and `resetRace` puts back what a race
left on the static scene (rubber, kicked cones, collected boxes, bursts).
`ttp_display_release` drops the field alone, so the static scene holds its GPU
memory until another track builds or the renderer goes.

- **Nothing static may depend on the ROSTER**, the casters least of all
  (`setVisibleLayers` 0x02: cars cast nothing). A static piece that varies with
  the field is silently kept stale — a scene lit by, or dressed for, the last
  field. Keep a thing by what it varies on.
- **Whatever `buildField` makes, `releaseField` frees** — the monster chassis'
  duplicated instances and the pools' `mAssetMeshKey` entries included. A field
  resource left on a scene-scoped list piles up once per rebuild until the track
  changes. `loadInstancedProp` does not dirty the dressing merge (only
  `buildStatic` does), or every field rebuild would regroup the whole dressing.
- **Split a build before optimising it**: `bakeShadowMap`, `buildStatic` and
  `buildField` each log their phases (`PhaseLog`). The sun bake is most of a
  static build on the weak box, and its time is GPU waits (`flushAndWait` between
  blur passes), not CPU.
- **TIME A REBUILD, NOT A PROCESS'S FIRST BUILD.** That one pays pipeline creation
  and the kit's texture decode once; read a phase's split off a second build in
  the same process. A cache of parsed assets buys the warm rebuild's phase, never
  the cold build's — price it against that.
- **The one-time half is a warm-up problem.** Filament's Vulkan pipeline-cache
  prewarming needs an extension the reference box lacks, so the effect pools are
  drawn once before the race (`warmEffectPipelines`) and the compiled pipelines
  persist in a file the Android shell names (`setPipelineCacheFile`).
- **Car bodies ARE kept** (`mBodyPool`), and **parking restores nothing**: a
  parked body still wears the last frame's pose, so `takeAsset` hands one back at
  its snapshotted parse pose (`mBodyRest`). Anything added to a reuse path asks
  the same question: what would a fresh `createAsset` have guaranteed?

## The sun: one static light rule, three receivers, three maps

**A static surface's light is vertex data, and its sun shadow is one tap into a
BAKED visibility map, or nothing.** Filament's shadows are off: it re-renders its
map per VIEW per frame, which a split screen pays per cell for geometry that
never moves. `bakeShadowMap` renders the casters' depth from the sun once per
static scene, filters it into an ESM, decodes that into the visibility maps, and
destroys it — nothing samples the ESM in a frame (`ttp_sunvis.inc` is included by
the bake materials alone). A lit material that MOVES (vlit) receives no shadow.

The receivers' light (`(ambient.rgb, NoL)` in custom0) is one CPU fill,
`bakeVertexLight`, the twin of `ttp_shade.inc`'s smooth terms; the sun's colour
stays a frame uniform rebuilt from the baked NoL. Their maps differ by
parameterisation, and the reasons are the rule:

- **The GROUND** (vground.mat) taps a map on the LIGHT's own grid (vvis.mat
  renders it through the ESM's camera), which works only for a surface that is
  single-valued under a near-overhead sun. One surface, no depth buffer.
- **The STRUCTURES and BERMS** (also vground.mat, white albedo) share a SECOND
  light-space map, DEPTH-TESTED. One map cannot hold the ground and an occluder
  above it: drawing the occluder erases the very texels of its own cast shadow.
- **The DECK** (vroad.mat) taps a map in TRACK space (vroadvis.mat): a barrel roll
  sits directly over the deck it shadows and a loop has two arclengths at one
  `(x, z)`, so no light-space map can hold it.

**A caller must own the sampling rate, IN BOTH AXES.** Light is smooth over metres
and survives a coarse mesh; a shadow's edge does not. The road's rings are fine
ALONG the track but its cross-section leaves most of a lane with no vertex, so
visibility could never be a vertex term there (`vroadvis.mat` has the
measurement). Any new receiver gets a map, not a per-vertex shadow.

**The maps are a function of the static key**, so the bake's reuse branch keeps
resident ones and an IMPORT is the one way they arrive without their scene: the
blob walk offers a key's blob before that key's static build, `importBlob` adopts
the key, and the bake consumes it. A resident static scene of any OTHER key is
released by the import first, because its receivers still sample the maps the
import replaces.

## Derived bytes: the blob rules

**A blob carries exactly what the runtime samples**: the three visibility maps and
the two numbers that address them (`shadowFromWorld`, the deck map's lat span).
Residency (`blobResident`) is those maps under `mBakedKey`. The walk, its
frame-beat write half and why a readback cannot be waited on inside a build are
`ttp_display.h`'s "derived bytes" section — that is the one home of that rule.

- **Stage, then finish.** `stageBlob` snapshots everything that is not a readback
  (header, key, matrix, the GL row-flip) and issues the reads;
  `collectStagedBlobs` finishes them on a frame beat. A finish that read the
  metadata late would pair one build's pixels with another's matrix.
- **A texture a staged read is still writing into may not be destroyed.**
  `replaceVisMaps` sends it to `mTexGraves`, drained once the read lands.
- **A read that never lands is LEAKED on purpose** at teardown: the driver may
  still hold a pointer into it and no tick is left to fire the callback.
- **A receiver fed by a readback and one fed by a tap disagree silently.** A
  dropped read once left the web deck lit but unshadowed for a whole session
  while the ground looked right. Prefer a tap.

**AN IMPORT OWNS ITS PIXELS.** A `PixelBufferDescriptor` over the caller's bytes
is a use-after-free that a `flushAndWait` does not cover: the shells free their
offer buffer when the ABI call returns, and a shell that reuses one address per
offer then has every layer uploading whichever blob was offered LAST — a shifted
copy of the wrong blob rather than nothing, which reads on screen as one thing
winning everywhere and not as a lifetime bug. Copy on the way in; a shell
promises only that the bytes are valid for the call.

## The per-frame budget

A steady-state race frame is one `ttp_display_frame(dt)`, one
`ttp_audio_frame(now)` and a packed cell-rects read. The rest of the HUD is a
low-rate poll: **nothing in the DOM is written per frame.** Anything tempted onto
the per-frame path needs to actually CHANGE per frame.

**THE DECK IS THE FRAME.** `ttp_display_debug_features` drops one group of
renderables at a time and `scripts/perf-features.mjs` reads the GPU timer around
each arm; run it before optimising anything, because the answer is lopsided:

- The **road** alone costs more than the rest of the scene together; terrain, set
  dressing, sky billboards and the effect pools are about the empty-scene floor.
- **Cars are a net NEGATIVE**: they occlude more deck than they cost to draw. On
  this scene, anything that keeps a road fragment from being shaded is worth more
  than anything that makes a car cheaper.
- Inside the road, the **decal channel** is the one worth watching.
- **The deck's cost is the one or two chunks under the cameras.** A per-chunk gate
  that disarmed most chunks moved nothing, which refutes the whole family of
  "gate the deck by region" — distance LOD, fog culling, a cheap far material.
  Spend on the near deck's shader or spend nothing. This holds on the Apple TV
  too, where the deck is the largest content item at 4P 4K.

**A weak mobile GPU adds a second term: `fixed + per-megapixel`.** On the PowerVR
box the fixed part is a large share of the budget on its own, and no render scale
reaches under it. Run an arm at a PINNED render scale at TWO resolutions, or the
halves cannot be told apart; measure the fixed half with the scale near the floor.
`ttp_display_gpu_ms` is REAL on that backend. `shells/androidtv/CLAUDE.md` carries
the method; the frame map carries the numbers.

**The fixed half is the scene being SUBMITTED, and it has no single hot spot** —
not the deck's vertex count, its draw count, the overlay pass or the present. Do
not go looking for the one thing again. **And it is per-vertex SHADING, not vertex
COUNT**: the lit kit copies cost where the unlit sheets with twice the vertices
cost nothing (`ttp_display_dress_keep` / `ttp_display_dress_sheets` split them).
So:

- **Make a vertex cheaper to shade.** Static unlit SHEETS fold the matte light into
  their vertex colours at build (`Mesh::bakeLight`, `bakedMatteLight`); the static
  kit copies do the same through their merged groups; the shadow RECEIVERS keep it
  in custom0 (above). What lights live is only what MOVES — the cars, the cone
  pool, the windmill, the plane, the rockets. Lighting the kit material per vertex
  for those measured a null. The one visible difference of a vertex bake is a
  coarse smooth-normal cylinder lit between its vertices.
- **Triangle ORDER is a cost too.** A tiler re-shades a vertex per primitive batch,
  so `buildMesh` reorders every OPAQUE range and its far form for vertex reuse
  (`reorderForVertexReuse`), within the range. **Nothing may depend on triangle
  order inside an opaque range after build**; a blended mesh keeps its order.
- **A far-plane cut buys nothing**: the scenery is authored to end where the fog
  saturates (`RACE_FOG_FAR`). Chunking deck and terrain for cullability was
  built and reverted: the GPU it saved, the extra renderables spent on the frame
  thread.
- **The exception is a FAR FORM per cell** (`LodRange`, `chooseLods`): the 4P frame
  is two pictures, the clean seconds and a few a lap where every cell looks across
  the whole circuit. A listed renderable owns a second index range that strays at
  most `err` world units, drawn past the distance where `err` covers `kLodPx`
  pixels OF THAT CELL. The deck's is a ribbon over same-coloured rings; a static
  unlit mesh opts in with `simplify`; the flowers do not (it strips the petals).
  It runs at every cell count (the user's call). **Read a 4P lever on the heavy
  seconds (`perf-race --timeline`), never the run's median.**

Where four players land against the budget, and why 540 is the floor, is
`ttp/render_scale.h`'s.

**THE KIT'S COPIES ARE MERGED DRAWS** (TtpRenderer.h, "Merged draw groups").
The car field and the per-copy dressing are re-issued as one renderable per
distinct MESH with an explicit `InstanceBuffer` — automatic instancing cannot
batch them (depth-bucketed and winding-split). The rules that keep it honest:

- **The gltfio originals stay the source of truth.** Their entities remain; the
  groups MIRROR node world transforms per frame (`updateMergedTransforms`), so the
  wheel spin/steer/travel, the monster park, the ghost swap and `debugHideCars`
  are inherited, never re-implemented. The monster swap is PER CELL, so
  `renderCells` re-mirrors while one is on.
- **Geometry comes from the same GLB bytes the shell provided**, through
  `ttp/glb_mesh.h` (the `glbmesh` ctest executes it), and materials are SHARED
  from the originals'. A model the reader cannot fully decode keeps drawing as
  gltfio loaded it — the fallback is whole-model, never a partial merge.
- **A merged group culls as ONE box.** Teardown order matters twice:
  `destroyCarSlot` kills the groups BEFORE the asset whose instances they share,
  and `releaseScene` destroys them while the source entities are still alive.
- **A STATIC dressing group is BAKED, not instanced** (`MergedGroup::baked`,
  `bakeMergedRun`): the copies expand into one world-space mesh whose vertex
  colour is texture × live baseColorFactor × matte light, drawn unlit. The texture
  half comes from `generated/kit_colors.h` (`scripts/gen-kit-colors.mjs`, gated by
  codegen-freshness) — the kit's atlas is flat swatches, so a vertex sample
  interpolates back to the picture. The FACTOR is read from the live instance,
  never the GLB, because the biome recolours untextured models through it. A model
  the table does not know keeps the instanced, live-lit draw.
- The item-box fade twins stay unmerged: they hold PER-INSTANCE materials.

**What a draw cut buys is a fact about the device.** On a fill-bound frame (the
Android box) it steadies the tail and leaves the median; on a submission-bound one
(the Apple TV) it moves the median. Price it per platform.

**Measured dead — do not rebuild:**

- **Per-cell quarter-size targets.** A pass costs its ATTACHMENT, so a cell drawn
  into a quarter target is cheaper — but the full-surface composite that puts the
  four back costs more than all of it saves (`--aa 1` is that shape). **Price a
  pass by running it, never by fitting a per-pass term** over a resolution sweep;
  the overlay pass is the counter-example.
- **An sRGB surface in place of the grade LUT**: pixel-correct on all three
  platforms, a null on the Android box, a win only on the Apple TV — and the hunt
  rule is "improves the weakest device". A two-drawable CAMetalLayer dropped
  frames at 4P 4K.
- **A cheaper antialias.** `ttp_display_antialias` is a switch whose saving is the
  offscreen scene BUFFER, not the FXAA filter, so a shorter span or a 3-tap filter
  chases the small half: the decision is BINARY. **Both TV shells turn it off**;
  the web keeps it. What vpresent's custom shader buys is the pass count.
- **Approximating a transcendental** over a full-screen surface: a fitted
  replacement for the sRGB `pow` measured no faster.

**THE FOG IS OURS, PER VERTEX** (`ttp_fog.inc`), and the view's fog is off.
Filament's costs a SHADER VARIANT (a cubemap sampler and a pow behind branches this
scene never takes), which its own `linearFog` does not fix; per fragment ours was
still several times the per-vertex cost. **A per-vertex term needs vertices**:
anything large, flat and fogged carries enough to interpolate between (the ground
sheet's STEP).

**A dynamically-indexed uniform ARRAY costs whether or not the loop runs, and it
costs by DECLARED SIZE** (`vroad.mat` has the readings). That is why the car
shadows left the list for the carShadow tap, which declares no array, and why
widening the profile arrays to take far cars was a loss. **Raising a cap is
measurable in the frame**; `tests/road-decal-caps.test.js` holds the material's
array sizes and each loop's clamp to the C++ constants.

**MOVE THE SMOOTH HALF OF THE SHADING TO THE VERTEX STAGE**, the trade the fog
made: light is smooth over metres, COLOUR is the detailed half.
`ttpMatteAmbient` / `ttpMatteSunTerm` are the split (`ttp_shade.inc`), and where
both are frame-invariant they are baked (above), so the per-frame vertex stage is
left with a move and the mesh emits no tangents.

`public/display/render/Display.js` is the browser's whole edge of this; for
measuring frame cost see `public/display/CLAUDE.md`.
