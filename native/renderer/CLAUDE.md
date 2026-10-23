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
4. Anything placed in track space must agree with **what the rasterizer
   computes from uv0** — the road's own ring polyline, the ring-plane blend,
   then the exact per-triangle interpolation, because uv0 kinks at every
   diagonal. Every cheaper approximation saw-tooths at ring-crossing rate;
   `project()`'s comment has the ladder, and the smooth surface `deckFoot`
   walks is one more rung of it (right for seating a body, wrong for placing
   paint — it cost the car shadow a visible shiver through every bend, back
   when it was a track-space layer; it is its own pass now, see below).
5. **A texture sample under NON-UNIFORM control flow must be `textureLod`,
   never `texture()`** — an implicit-derivative sample there is undefined
   behaviour, and the rule is the whole renderer's (the deck's layer taps, the
   ESM decode in `ttp_sunvis.inc`, vpresent's FXAA span taps). Every map involved
   is single-level, so LOD 0 is what an implicit sample would pick. On ANGLE's
   Metal backend the UB read as a car shadow intermittently rendering nothing,
   and any instrumented reshape of the shader moved it; when CPU inputs check out
   at the failing moment, suspect the sample.

**One box gates each loop.** `profBounds` and `paintBounds` are the union of
their entries' own reject windows, so they are exact: a fragment a box rejects
would have rejected each entry in turn. **Build it from the same bound the loop
tests** (`rect.zw`), or the box clips a stamp the loop would have drawn. The
paint list's box was the second one, and it was worth ~0.7 ms of a 4P 720 heavy
second on the Android box (the frame map, 2026-10-14) — a uniform-bounded loop
that early-outs per entry is not free on a GPU with few ALUs. **A per-chunk
gate on a deck TAP is not the same lever**: the deck on screen is the few
chunks under the cars, so disarming most of the lap moves nothing (the rubber
tap, 2026-09-04; the sun-vis tap, 2026-10-14, ~0.15 ms with 26 of 32 chunks
white). And `kFeatRoadShadow` prices three maps at once — it rebinds the
ground's and the structures' maps to 1x1 white — so read its arm as the
ground's tap first, not the deck's.

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
list: they are their own pass (below), drawn after the deck, so an aura lands
UNDER its own car's shadow — accepted when the pass replaced the tap.

## The car contact shadow: one draw per car, on the road's own surface

**EVERY car's contact shadow is a blended draw of its own** (`vshadow.mat`,
`placeCarShadow`): the road's own triangles under the stamp's box in track
space, clipped to that box, with the fitted rounded rect sampled from a texture
locked to the car's frame. It replaced a track-space R8 layer that was
CPU-rasterized and uploaded every frame and tapped (with a B-spline under the
stamps) on every road fragment; the frame map (2026-10-14) has the whole
ladder. What the pass is built on, and why each piece is what it is:

- **The geometry IS the deck's own planes.** Per ring cell and per deck
  strip the box touches, the cell's two triangles are clipped in (t, lat) to
  the box and each clipped corner mapped through that triangle's affine map
  (`TrackBin::deckQuadAt` gives the corners), so the depth test is a tie
  that a bias must break. A ruled strip between ring lines was tried first:
  where the deck twists it sat behind the road's chord, a banked stretch
  lost its shadows and the ends flickered. **The clip is to the stamp's
  SUPPORT in (u, v)**, not to a track-space box: the baked field's non-zero
  texel box (`CarShadowStamp::support`) is affine over each road triangle,
  so clipping there is exact, and every fragment a box adds beyond it is
  paid for nothing — a yawed car's box is twice its quad, and that clip was
  about half the pass's cost on the box (the frame map, 2026-10-17).
- **The depth bias is a shrink toward the eye in the vertex shader, not a
  polygon offset.** Each vertex moves a fixed fraction of its distance along
  its own eye ray (`vshadow.mat`): the screen position is unchanged, the
  depth lands in front of the road's by that fraction at every grazing angle
  on every backend, and early depth culling stays on. The two polygon offsets
  both failed: one constant unit is under the rounding between the two
  triangulations of the same plane, so the shadow lost the depth test over
  most of its area (a stippled remnant on the web, "a complete mess" on
  another GPU), and a slope term grows past the car on a face seen at a
  grazing angle. A tyre in front still wins the depth test: the shrink is a
  millimetre at three units. Filament's depth is REVERSED: the material's
  default compare is already "nearer or equal", and a hand-set LE let every
  fragment pass over the cars. `TTP_DEBUG_SHADOW_SOLID` draws every stamp as
  an opaque black die-cut of its fitted rect, which is how placement, depth
  and seams are judged by eye on a TV.
- **The road's own cells cannot be the geometry.** The cross-section has no
  vertex column inside a lane, so the tightest cell under a car is half the
  road wide; drawn that way the pass cost +1.8 ms of a 4P 720 heavy second
  with a trivial shader, and +3.3 with the real one. Fragments are the whole
  cost of this pass — the eight draws measured nothing — so the geometry must
  be the stamp's own area.
- **The shape is a texture, not arithmetic.** The rounded rect's ramp field
  (`carShadowStamp`, one 128-square R8 per car MODEL, mip-mapped, kept for the
  run) is sampled at (u, v) the VERTEX stage emits, since the stamp's
  coordinates are affine in world position. Evaluated per fragment the same
  shape was 1.5 ms. Locked to the car, nothing re-lands on a road grid frame to
  frame: no bands, no shiver, no filter to pay for. The baked field is the
  raster's ramp blurred by a texel (the reconstruction the layer's read
  carried; it also hides the distance field's creases along the corners'
  diagonals). A ramp twice as wide read as a weak shadow with a small core.
- **Lit per vertex, in display space,** from the deck's mean baked full
  light per ring (`mRingLight`, encoded like every light term) times the
  encoded ink, fogged and premultiplied per fragment like vblend. The blend
  lands in display space; a remap of the alpha to the linear mix's weight
  matched the layer on paper and read too weak on the TV, so the stamp's own
  alpha is the look.
- **A rebuilt scene's instances know no stamp**: the per-slot memory of which
  model is bound (`mCarShadowStampBound`) is reset with the draws, or the race
  after the lobby draws nothing.
- **Its vertex and index buffers are a ring of `mCellRing` pairs** (the
  streak ring's rule, `buildCarShadowDraws`). Written through one pair they
  were STAGED on the Vulkan box every frame: copies and a `VERTEX_INPUT`
  barrier ahead of every frame's first vertex kick, outside the GPU timer's
  interval (the frame map has what the ring bought). Any buffer written per
  frame belongs in a ring.
- Each car also pushes a READBACK-ONLY entry (`DeckDecal::car`, folded into no
  chunk) so `ttp_display_debug_decals` and the warp bench can read the car rows.

**THE SHAPE IS A ROUNDED RECT FITTED TO EACH MODEL'S OWN OUTLINE —
four corners for every car, by the user's eye** (`ttp/car_footprint.h`,
executed on every leg by the `carfootprint` ctest). The model's triangles are
projected top-down and rasterized on the CPU out of the same GLB bytes the
merged draw groups already decode — no parse, no GPU pass, no readback — and
the fit (fill across, fill along, corner radius) is one pass over that coverage.
A fitted k-gon and an outline-mask arm were built and not chosen
(`CarShadowTuning`'s header says why).

**The AABB cannot do this job, which is the whole reason the footprint exists.**
All four roster cars are built to nearly the same bounding box and are
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

**The edge is a WIDE MEDIUM BAND cut in the SHADER over a wide field**; both
cliffs beside it are measured, and `CarShadowTuning` carries them. **The band
must stay non-empty** (`remapHi > remapLo`): a degenerate smoothstep is UB.

**Judge a shadow change on the TV, in a race, with each variant in its own
colour — never from stills.** A reconstruction filter the road-space layer
once carried read identical in frozen frames and pulsed bands in motion; the
pass was judged the same way (a colour per variant, `debug.ttp.features`
flipped live, and `TTP_DEBUG_SHADOW_SOLID`). **When a decal channel draws
nothing, suspect the TEXTURE CONTENT first**: stage tints cannot reach inside a
sample. A TRANSLUCENT bake into an R8 array layer once rendered ZERO coverage on
the PowerVR driver while logging success. A bake that renders nothing has to SAY
so.

**The stamp's box is laid from the plane the car SITS on**: a stamp that
changes shape through a flat bend is a placement bug — no pixel work needed.

## Colour: the scene is authored in display space

**No material encodes anything per fragment.** Every colour a scene material
reads is already what the panel shows — sRGB, pre-exposed — and the fragment
stage multiplies and mixes: a vertex colour (`packAlbedo` / `packShown`), a
texture's bytes (every colour texture is plain RGBA8, the kit atlas through
`DisplayTextureProvider`), a colour parameter (`encodeSrgb` at the setter,
`displayKitFactors` for what gltfio sets), a baked light term (`displayLight`
in `bakeVertexLight`, two per receiver vertex: ambient, and ambient plus sun,
mixed through the visibility tap in the fragment). The one shader-side encode
is the live-lit VERTEX stage's (`ttpMatteLightDisplay`), for what moves.
`TtpRendererImpl.h`'s header carries the argument, the exactness, and what is
only near exact; `vpresent` and `voverlay` sit past all of it and read bytes.

- **A new colour input states which it is.** An albedo (something a light term
  multiplies) encodes without the exposure; a colour shown as it is (an unlit
  material's vertex colour, the skybox, the fog) carries it. A light term is
  never clamped — the clip belongs on the product, in the 8-bit buffer.
- **A new colour texture is RGBA8, never SRGB8_A8**: the decode the sampler
  would do is exactly the step this removes.
- **An unlit material writes `baseColor`, never `emissive`**
  (`tests/material-rules.test.js`). Unlit passes `baseColor` through
  untouched; an `emissive` write makes matc compile Filament's `addEmissive`
  (an exposure mix and a multiply-add, highp) into every fragment of that
  material for nothing. The gate lists the exceptions with their reasons:
  `vglbfade`, whose alpha rides `baseColor` and whose colour must be
  premultiplied by it; the bakes (`vesm`, `vvis`, `vroadvis`), which run once
  per track; and `vpresent`, which is off on the box. None of the four was
  priced, so none was moved.
- **Display colour is `precision : medium`** in a scene material's
  `variables`: within 1/2048 of the value, under an eighth of an 8-bit step,
  and the F16 rate on the PowerVR box (on Metal SPIRV-Cross keeps the
  interface at float and only the fragment's own ops go half). Texture
  coordinates and world units stay high. `vshadow` is medium though blended;
  the other blended materials (`vglbfade`, `vblend`, `vcloud`, `vburst`,
  `vpoint`) keep their default precision.
- **The kit colour table is the atlas's own bytes** (`gen-kit-colors.mjs`),
  sampled the way the GPU samples them; the merged bake decodes them to
  multiply the light and encodes the product once.
- **Blends, fog and the deck's compositing happen in gamma space**, as they
  did when the grade was per fragment; the frame map (2026-10-17) has the
  paused-frame comparison that priced the receivers' penumbra mix at the
  noise floor.

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
- **The ribbon is anchored at the wheel's contact patch, with NO lead along the
  body axis.** Permanent additive ink cannot be drawn ahead and rewritten, so the
  head lags by up to `SKID_SEG_MIN`, under the tyre. A body-axis lead lands the
  mark beside the path whenever the body is yawed off its travel (drift, spin-out).
- **Ink is permanent until the race-restart wipe.** A decay pass was the layer's
  whole recurring GPU cost. **Do not add a per-frame fullscreen pass here without
  measuring on the weakest shell** — the mip refresh is throttled for exactly
  that reason. The chain is needed (the deck ahead minifies an 8k-wide texture;
  `mMaxTextureDim` is a chosen ceiling, clamped down by the driver, never up);
  its throttle rides `mTime`, so its timestamp is cleared with the texture.
- **Every deck tap reads a BARE `.xy` varying of its own**
  (`tests/material-rules.test.js` holds every material to it). A coordinate
  swizzled out of a varying's other components (`.xz`, `.zw`) counts as a
  DEPENDENT read on PowerVR (Imagination's texture-sampling rule), which the
  GPU cannot issue before the shader runs; so the rubber layer's uv and the
  vis map's uv are two varyings, not one packed vec4, and the deck's
  chunk-local arclength and lat ride the spare components instead.
- **The tap reads the uv RAW** (an upload has no per-backend flip; the suite
  audit `tests/render-target-uv.test.js` classifies the sampler), and the stamper
  keeps the texture's outer lat rows empty, which parks the kerbs' and
  underside's out-of-band v on zero ink.

**The rubber layer is not a render target, and must not become one.** An
ACCUMULATING attachment was device-broken in every arrangement on the A10X Apple
TV — below the API, identical command streams from the Metal backend, invisible
to GL and the simulator. Uploads are the path every other texture already proves
out. The bakes stay transient-RT and are fine: they repaint whole layers.

**On the Android GL backend the layer is a ring of two textures** (`mSkidRing`),
because that driver answers an upload into a texture a frame in flight samples
with a copy of the whole texture: each frame writes the slot the frame before
last drew (the frame skipper tolerates one frame in flight, so that one is the
oldest it lets through) and owes the write to the other slot. A ring of three
measured worse (every slot owes every upload), and so did issuing the uploads
after `beginFrame`'s fence check instead of before it (the check is a poll, not
a wait, and the uploads then sit between the check and cell 1's draws).
The same backend caps the layer at 4096 wide (the Vulkan driver's own cap) and
runs with material-instance uniform batching OFF; decided in
`TtpRenderer::init` and `engineBuilder`. Any backend with one slot is unchanged.

## The static scene and the build

**THE STATIC SCENE IS A FUNCTION OF ITS KEY, and a build whose key matches the
resident one rebuilds only the FIELD.** The key is the shim's
(`track|biome|showcase|backend`, `bakeKeyFor`) plus the inputs the renderer
latches — shadows, the bench, the model variants, the kit field — whose setters
drop it on a change (`dropStaticKey`). The track, its dressing, the sky and the
sun bake stay up across a join, a leave, a race launch and a restart; `rebuildField`
rebuilds the cars, and `resetRace` puts back what a race left on the static
scene (rubber, kicked cones, collected boxes, bursts).
`ttp_display_release` drops the field alone, so the static scene holds its GPU
memory until another track builds or the renderer goes.

- **Nothing static may depend on the ROSTER**, the casters least of all
  (`setVisibleLayers` 0x02: cars cast nothing). A static piece that varies with
  the field is silently kept stale — a scene lit by, or dressed for, the last
  field. Keep a thing by what it varies on.
- **Whatever `buildField` makes, `releaseField` frees — unless it is keyed, and
  then its key does.** What depends on the car COUNT (the monster rig and its
  ghost, the boost streaks) is kept for a field of the same size and freed by a
  build of another count. The monster pools vary on nothing else, so they
  outlive the static scene too: besides a new count, only new bytes for a
  monster GLB (`provideAsset`) or the destructor free them
  (`releaseMonsterPools`). The streaks wear the scene's boost colour, so
  `releaseScene` frees them (`releaseStreakPool`). Kept is not left up —
  `releaseField` takes it out of the scene, because frames draw between a
  release and the next build — and the build puts its per-race state back.
  Either way the monster chassis' duplicated instances and the pools'
  `mAssetMeshKey` entries go with their owner: a field resource left on a
  scene-scoped list piles up once per rebuild until the track changes.
  `loadInstancedProp` does not dirty the dressing merge (only `buildStatic`
  does), or every field rebuild would regroup the whole dressing.
- **Split a build before optimising it**: `bakeShadowMap`, `buildStatic` and
  `buildField` each log their phases (`PhaseLog`).
- **A bake never `flushAndWait`s**: its GPU time belongs behind the thread that
  pumps frames and the relay. `bakeShadowMap`'s header has the ordering argument.
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

The receivers' light (custom0 the encoded ambient with the raw NoL in .w for
the bakes, custom1 the encoded ambient plus sun) is one CPU fill,
`bakeVertexLight`, the twin of `ttp_shade.inc`'s smooth terms. Their maps
differ by
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

- The **road** alone costs more than the rest of the scene together on the web.
  On the Android box after the display-space change the map is flatter: terrain
  (the fill the ground, hills, berms and structures cover, no member of it
  dominant) is the largest channel, then dressing, decals and cars within a
  millisecond of each other, and sky and effects in the noise (the frame map,
  2026-10-17 night).
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

**The fixed half is vertex ALU on the deck and the ground, and a vertex is
cheaper in the WORLD domain.** `vroad` and `vground` declare `vertexDomain :
world`, which skips the model matrix (a dynamic UBO load and a mat4 multiply per
vertex) — worth ~0.8 ms of a 4P 720 heavy second on the Android box, where the
same twin for the dressing sheets measured nothing (the frame map, 2026-10-14).
Two contracts keep it honest: every mesh those two materials draw is built in
world units on an IDENTITY transform, and `TtpRenderer::init` turns Filament's
camera-at-origin shift off (`d.view.camera_at_origin`), AFTER the first View is
created, because that is where Filament registers the property — set earlier it
is a silent no-op and every world-domain vertex lands offset by the camera. With
the shift off, user world and world coincide (`getUserWorldFromWorldMatrix()` is
the identity), which vground's vertex stage relies on.

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
  It runs at every cell count (the user's call). **A chunk a car shadow lies on
  stays NEAR in every cell** (`mShadowRings`, from `placeCarShadow`): the
  shadow pass is the fine rings' own planes, and under the far ribbon's
  chords (up to `kDeckLodTol` off them) it lost the depth test — no shadow
  under a car two chunks ahead, and none under the player's own with
  `LOD_ALL`. **Read a 4P lever on the heavy seconds (`perf-race --timeline`),
  never the run's median.**

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

**A track's SET PIECES ride the same path** (`buildSetPieces`, the track's
`set` list in `public/shared/tracks.js`): composed GLBs instanced like props,
so they merge, bake and get a far form with no renderer path of their own. Two
things differ from the scatter, both deliberate. They CAST into the sun bake
(the baked run inherits the caster layer) — the bake is per track, so it costs
build time, never frame time. And everything seeded after them keeps out of
their oriented footprints (`mSetFeet`): they are authored, so they win their
ground. The scatters keep out of the grass berms the same way (`inBerm`), since
they ground a piece on the terrain beneath one; the verge band starts at the
berm's foot, and a prop is grounded under its model's own footprint and
dropped, never sunk, where its uphill edge would bury a quarter of its height. A piece is authored where it stands. What a piece costs at draw time is its vertices in the cells
that see it, so a heavy one belongs where few cells look at once, and is
priced on the box's 4P heavy seconds like any other geometry. A composed
model whose node names point at two meshes is REFUSED by the merge and draws
live-lit with nothing to say so, which is why `scripts/lib/glb-compose.mjs`
renames them; a kit model shipped whole can carry the same flaw (the budget
names it).

**New world content is priced on the host first, the box once per batch.**
`npm run budget:scene` counts what each cell submits over a whole lap (the
count is decided in this C++ before any backend sees it, so it transfers to
the box) and fails a track whose worst frame grows, a shipped track's 4P frame
over the baseline's `ceiling`, and any static dressing the merge left live-lit
(`ttp_display_debug_live_dressing` names it). The ceiling is a box fact, the
worst frame a track may have while 4P still holds, so it moves only on a box
reading. Over budget: move it off the vista (what every cell sees down the
straight), then make it lighter. Never a per-fragment term, a blended material
or a new material.
A biome PROP is capped per model before it is priced at all
(`tests/display-abi.test.js`): it is stamped many times a lap, and the kit
authors a barrel with a car's vertices. `scripts/slim-kit-models.mjs`
decimates a kit model from the ratio SOURCES.json records for it.

**What a draw cut buys is a fact about the device.** On a fill-bound frame (the
Android box) it steadies the tail and leaves the median; on a submission-bound one
(the Apple TV) it moves the median. Price it per platform.

**Measured dead — do not rebuild:**

- **Per-cell quarter-size targets.** A pass costs its ATTACHMENT, so a cell drawn
  into a quarter target is cheaper — but the full-surface composite that puts the
  four back costs more than all of it saves (`--aa 1` is that shape). **Price a
  pass by running it, never by fitting a per-pass term** over a resolution sweep;
  the overlay pass is the counter-example.
- **An sRGB surface in place of a per-fragment encode**: pixel-correct on all
  three platforms, a null on the Android box, a win only on the Apple TV — and
  the hunt rule is "improves the weakest device". A two-drawable CAMetalLayer
  dropped frames at 4P 4K. Moot now that no fragment encodes (above), kept
  because the swap-chain reading itself still holds.
- **The sky is a dome at the eye, not a skybox.** Filament's Skybox samples a
cubemap on every sky pixel through its own material, ~0.6 ms of a 4P 720 heavy
second on the Android box; `vsky.mat` over `mSkyDome` writes a varying. The dome
is centred on each cell's camera and scaled to that view's far plane in
renderCells, which is the only placement that can never be clipped (the
world-origin dome's hole; `TtpRenderer.h`, mSkyDome). It is not a caster and not
fogged, and it is not on the `kFeatSky` arm, which is the sky's CONTENT.
Being opaque, it hides whatever is behind it, so the sky SPRITES (clouds,
balloon) are fitted inside the dome (`SKY_DOME_SHARE`), never just inside the
far plane: between the two a cloud is hidden whole and pops in as the car
drives toward it.

**A cheaper antialias.** `ttp_display_antialias` is a switch whose saving is the
  offscreen scene BUFFER, not the FXAA filter, so a shorter span or a 3-tap filter
  chases the small half: the decision is BINARY. **Both TV shells turn it off**;
  the web keeps it. What vpresent's custom shader buys is the pass count.
- **Approximating a transcendental** over a full-screen surface: a fitted
  replacement for the sRGB `pow` measured no faster — which is why the encode
  left the fragment stage altogether (above) rather than getting cheaper.

**THE FOG IS OURS, PER VERTEX** (`ttp_fog.inc`), and the view's fog is off.
Filament's costs a SHADER VARIANT (a cubemap sampler and a pow behind branches this
scene never takes), which its own `linearFog` does not fix; per fragment ours was
still several times the per-vertex cost. **A per-vertex term needs vertices**:
anything large, flat and fogged carries enough to interpolate between (the ground
sheet's STEP). On `vroad`, `vground` and `vcolor` even the fragment's mix is
folded away (`ttp_fog.inc`, `ttpFogTerm`, has the algebra): `(1 - a)`
multiplies into the light halves (or the vertex colour) per vertex and `F a`
rides a spare varying component, leaving the fragment one add.

**A dynamically-indexed uniform ARRAY costs whether or not the loop runs, and it
costs by DECLARED SIZE** (`vroad.mat` has the readings). That is why the car
shadows left the list for their own pass, which declares no array, and why
widening the profile arrays to take far cars was a loss. Those readings were
taken on a longer fragment: after the display-space change, compiling the
deck's loops and arrays out altogether read null at 4P/720 (the frame map,
2026-10-17 night), so measure before spending on this rule again. **Raising a cap is
measurable in the frame**; `tests/road-decal-caps.test.js` holds the material's
array sizes and each loop's clamp to the C++ constants.

**MOVE THE SMOOTH HALF OF THE SHADING TO THE VERTEX STAGE**, the trade the fog
made: light is smooth over metres, COLOUR is the detailed half.
`ttpMatteAmbient` / `ttpMatteSunTerm` are the split (`ttp_shade.inc`), and where
both are frame-invariant they are baked (above), so the per-frame vertex stage is
left with a move and the mesh emits no tangents.

`public/display/render/Display.js` is the browser's whole edge of this; for
measuring frame cost see `public/display/CLAUDE.md`.
