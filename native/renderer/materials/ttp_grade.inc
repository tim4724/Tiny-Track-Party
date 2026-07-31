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
vec3 ttpGrade(vec3 linear) {
    vec3 c = max(linear * TTP_GRADE_EXPOSURE, 0.0);
    return clamp(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
            step(0.0031308, c)), 0.0, 1.0);
}
