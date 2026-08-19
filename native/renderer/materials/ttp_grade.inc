// The grade — exposure, then linear → sRGB — in ONE place, applied by every
// material that writes into the scene buffer.
//
// IT USED TO LIVE IN THE PRESENT PASS, and moving it is the whole point. FXAA
// blends DISPLAYED colours, so vpresent had to encode every tap it took: five
// per pixel on a flat area (centre plus the four luma-cross corners) and nine on
// an edge, each a pow(vec3) — fifteen to twenty-seven transcendental calls per
// pixel to produce one. Doing it here instead costs one per SHADED FRAGMENT, and
// the present pass becomes plain texture fetches over values that are already
// what the panel will show.
//
// Measured on an M1 Max, four players, countdown grid, with the frame-rate limit
// off (under vsync this frame is idle four fifths of the time, downclocks, and
// an identical build reads across a 1.5 ms band — do not measure this at 60 Hz):
// deleting the encode from vpresent outright was worth 0.04 ms at 3200x1800,
// 0.25 ms (6%) at 3840x2160 and 0.82 ms (12%) at 5120x2880. It is a pure FILL
// cost, so it is worth nothing at 1600p and real on a 4K panel.
//
// WHAT IT COSTS, and this is not a detail: the scene buffer now holds sRGB, so
// everything that BLENDS into it blends in gamma space — the transparent
// materials (clouds, water, skid ribbons, contact blobs, ambient motes), the
// ADDITIVE burst, and Filament's fog, which is composited inside the surface
// shader after material() returns. See ensureSceneTarget for the buffer format
// that had to change with it, and buildScene for the two colours (skybox, fog)
// that C++ now has to pre-grade because their shaders are Filament's, not ours.

// The exposure the present pass used to apply (SceneRenderer's DEF_EXPOSURE).
// MIRRORED IN C++ as TtpRenderer's kGradeExposure, which pre-grades the skybox
// and fog colours — those two go through Filament's own shaders, which cannot
// include this.
const float TTP_GRADE_EXPOSURE = 1.1;

// Pre-exposed linear → the value written to the scene buffer. Clamped, because
// the buffer is 8-bit UNORM now and anything above 1 was being clipped by the
// present pass anyway.
// A TABLE, NOT A `pow`, and the reason is which UNIT each runs on. `pow(c, 1/2.4)`
// compiles to `exp2(log2(c) * k)` — two special-function ops per channel, six per
// fragment, on the one narrow pipe a mobile GPU has fewest of. Three taps into a
// 1024-entry table run on the TEXTURE unit instead, which is idle here and can
// overlap with the ALU work around it. Measured on a PowerVR GE9215 over a live
// single-player race at 1280x720: 18.4 ms of GPU down to 17.5, with a picture
// that does not differ.
//
// It does not recover the whole cost of the encode — deleting it outright reads
// 15.7 — so the taps are not free either. It is simply the cheapest way this
// tree has found to spell the curve. AN sRGB RENDER TARGET IS NOT THE ANSWER
// HERE: it is correct and it is 3.5 ms SLOWER on that driver, which is written
// down in shells/androidtv/CLAUDE.md so nobody re-derives it.
//
// 1024 entries because the curve's 12.92x toe puts a tenth of its range inside
// the first 1/255th of the input; at 256 the darks quantize visibly against the
// exact curve, and the table is cache-resident either way.
//
// A material that includes this file must declare the sampler — `materialParams`
// is per material and matc will say so. TtpRenderer::buildScene binds it once as
// a MATERIAL default, which is the only place every one of them can be reached.
vec3 ttpGrade(vec3 linear) {
    vec3 c = clamp(linear * TTP_GRADE_EXPOSURE, 0.0, 1.0);
    return vec3(textureLod(materialParams_gradeLut, vec2(c.r, 0.5), 0.0).r,
                textureLod(materialParams_gradeLut, vec2(c.g, 0.5), 0.0).r,
                textureLod(materialParams_gradeLut, vec2(c.b, 0.5), 0.0).r);
}
