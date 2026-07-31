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

## Decals are shaded into the road, not laid over it

Flat on-deck decals are handed to `vroad.mat` as track-space rectangles and
painted by the road's own fragment shader, so a decal's fragment IS a road
fragment at the road's own depth: **no lift, no chord sag, no polygon offset, no
render order.** The road carries arclength in uv0, which is also why loops work —
a fragment knows its own arclength where one `(x, z)` has two.
`ttp_display_debug_decals` reads the packed floats back; use it rather than
inferring shader state from pixels.

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

**Chevrons are SDFs**, which let the pads move without a texture atlas. The apex
must LEAD or every chevron reads as a brake marking. A pad is **flat paint** —
reproducing the old mesh's radial gradient came out as an emissive saucer, the
exact read this tree rejected before.

Their grid is **a margin plus a packed run**, never one chevron per grid cell:
cells put more air between the marks than around them, so the outermost of them
crowd the decal's edge while the middle goes slack. Gaps are a fraction of a
mark's own size and the margin is what is left of the box. The **stroke is a
world width** while the layout stays normalised — that frame is anisotropic, so
one width in it is a different width on the road for every line ANGLE, and the
same expression gave a strip and a disc visibly different weights. The
rectangle's box height is **derived** from that stroke rather than frozen, or a
narrower strip clips its outer columns.

The car's contact shadow is a **masked** decal: its shape is the baked
silhouette, sampled from a small texture array (one layer per car slot, one for
the monster, one generic). The mask samples a **rigid planar projection of the
fragment's world position onto the car's own axes** — track space only BOUNDS
the stamp (that reject is what keeps a loop's other deck out). Painting the
silhouette in curvilinear (s, lat) instead bends it around every corner, and
the per-triangle kinks of the interpolated uv0 field ripple through its sharp
edge as the car crosses rings — shadow-edge shimmer on bends, flat on
straights. A layer whose bake hasn't landed falls back to the generic
superellipse — never to an unbaked layer.

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
discard=false) at the render call; the accumulation views stay on the
default OPAQUE blend mode. bakeSilhouette keeps TRANSLUCENT because
alpha-compositing is exactly what a mask bake wants.

**Skid marks are the same road-shader paint, accumulated.** The transient
decals above are re-packed every frame; rubber instead lands in a per-track
R8 texture in track space (u = s / lap, v = lat across the deck) that
`vroad` samples with one extra tap. ONE offscreen pass owns it
(`ensureSkidLayer`): additive stamps (`vskid.mat`) for each committed trail
segment. Ink is permanent until the race-restart wipe — a clear on that same
pass — because a decay pass was the layer's whole recurring GPU cost
(megatexels of read-modify-write) and permanence is also how a real toy
track behaves; the racing line rubbers in over a race. Do not reintroduce a
per-frame fullscreen pass here without measuring on the weakest shell. There is no pool, no budget and no
lift; unbounded marks cost fixed memory. The tap reads through
`uvToRenderTargetUV` (the layer is a render target — the suite audit
enforces this), and the stamper keeps the texture's outer lat rows empty,
which is what parks the kerbs' and underside's out-of-band v on zero ink.

## The per-frame budget

A steady-state race frame is one `ttp_display_frame(dt)`, one
`ttp_audio_frame(now)` and a packed cell-rects read. The rest of the HUD is a
low-rate poll: **nothing in the DOM is written per frame.**

**Anything tempted onto the per-frame path needs to actually CHANGE per frame.**

`public/display/render/Display.js` is the browser's whole edge of this; for
measuring frame cost see `public/display/CLAUDE.md`.
