// The read-out of the sun's exponential shadow map — a BAKE-TIME function.
//
// Only the visibility bakes include this (vvis.mat over the light's grid,
// vroadvis.mat in track space), inside TtpRenderer::bakeShadowMap. Every input
// is static per track, so the decode runs once per texel of a baked R8 map and
// a receiver pays one bilinear tap of that map at draw time (ttp_shade.inc says
// why that is the rule). The ESM itself is destroyed when the bake ends.
//
// Anything that reads materialParams must be declared by the INCLUDING material:
// shadowMap, shadowFromWorld, shadowTexel, shadowK and shadowDepthScale, which
// TtpRenderer::bindShadowMap fills by name.

// Half-width of the shadow's soft edge, in world units. This is a FLOOR on
// the transition, not its width — the bake blur (kPenumbraSigmaWorld) sets
// the width — but at 1.0 it WAS the floor most of the time, and it stopped
// the bake's sigma from buying anything below about half its old value.
//
// 0.6 is a measured optimum, not a round number. Sweeping it against the
// sharpened bake on skysnake's loop: 0.7 gives a 5.0 px edge, 0.6 gives
// 4.6, 0.5 gives 5.4 and 0.45 gives 5.2 — it turns back UP below 0.6. Lowering
// it also lets a shadow reach full black over a smaller gap — the ramp needs
// 2*kPenumbraWorld of depth separation — so pillars and posts read as solid
// contact rather than grey smudges. Watch for acne when changing it: biasN
// below takes the max of the slope bias and this, so it doubles as the acne
// guard on surfaces that face the sun (checked, and 0.6 is clean).
const float kPenumbraWorld = 0.6;

// ONE bilinear tap into the baked, pre-blurred exponential shadow map. The
// penumbra comes from the bake filter (vesm.mat) and the compare below, not
// from taps here.
//
// Depth is REVERSED [0,1]: 1 at the light, 0 at the far plane. The ortho
// camera's clip z arrives in [-1,1], and bakeShadowMap's bias matrix folds
// it with a NEGATIVE half-scale into that space (see the comment there —
// both halves of this were measured, not assumed). So a caster in front of
// us holds a GREATER stored depth than our own.
//
// Takes the LIGHT-SPACE uv directly, so a bake that has already transformed its
// receiver — vroadvis.mat, which rasterizes the deck in TRACK space and so
// cannot hand a world position to the matrix — reads the map through this exact
// spelling. The transform is affine and w is exactly 1 (an ORTHO light), so a
// caller may interpolate the uv across a triangle and get the same answer.
float sunVisibilityUV(highp vec3 uv, float NoL) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0
            || uv.z <= 0.0 || uv.z >= 1.0) return 1.0;
    // SLOPE-SCALED BIAS. ESM's bias is only inherent for a receiver whose
    // depth is constant across a shadow texel. A surface seen edge-on by the
    // sun is the opposite case: skysnake's loop wall sits ~7 degrees off the
    // light, so its own depth spreads ~0.46 world units inside ONE texel and
    // it shadows itself in a comb of dark tongues. Scale the guard by the
    // grazing angle so flat ground pays nothing for it.
    float slope = clamp(sqrt(max(0.0, 1.0 - NoL * NoL)) / max(NoL, 0.12), 1.0, 12.0);
    float biasW = materialParams.shadowTexel * 2.0 * slope; // world units
    // Recover the occluder depth in LOG space, then compare.
    //
    // The map holds a blurred exp(-k*d), and the obvious test is
    // clamp(exp(k*z) * occ). Do not: it throws the blur away. Written out,
    // that product crosses 0.5 where the occluder's share of the blur kernel
    // is exp(-k*(z - d_occ)) — for a track deck under a loop, and k anywhere
    // near 80, a number like e^-8. That is the extreme TAIL of the gaussian,
    // where the sum is dominated by whichever single texel happens to be
    // nearest, so the contour hugs individual texels and comes out as a
    // staircase. Map resolution, blur radius, tap count and cubic
    // reconstruction were each measured, and each left the staircase exactly
    // where it was.
    //
    // -log(occ)/k inverts the exponential and yields the soft-min of the
    // occluder depths under the kernel, which varies smoothly. Comparing
    // THAT, with a modest k (see kShadowEsmK), puts the crossing where the
    // occluder holds roughly half the kernel, and the contour is a smooth curve.
    //
    // THROUGH uvToRenderTargetUV, and it is not decoration. The map is an
    // OFFSCREEN RENDER TARGET, and the texel a render target's uv v = 0 names is
    // the FIRST ROW IN MEMORY — the bottom of the picture on OpenGL and the top on
    // Metal, Vulkan and WebGPU. `shadowFromWorld` produces a GL-style uv (y up: the
    // bias matrix is +0.5y + 0.5 out of NDC), so a raw sample reads the map
    // MIRRORED on those backends. Filament's own ShadowMap.cpp carries the same
    // correction, as its `Mf` term. On GL it is the identity, which is how a
    // missing one shipped: on Metal it put a hard-edged darker QUADRILATERAL
    // across the ground of every track.
    //
    // textureLod, NEVER texture(): the early return above makes this call site
    // NON-UNIFORM control flow, where an implicit-derivative sample is undefined
    // behaviour (native/renderer/CLAUDE.md). The map is levels(1) bound with a
    // non-mipmap filter, so LOD 0 is what an implicit sample would have picked.
    float occ = textureLod(materialParams_shadowMap, uvToRenderTargetUV(uv.xy), 0.0).r;
    // COMPARED IN LOG SPACE, i.e. everything below is k times the depth: the
    // compare, the ramp and the bias all scale by the same positive k.
    highp float k = materialParams.shadowK;
    highp float raw = uv.z * k + log(max(occ, 1e-30));
    // The transition's floor is a fixed WORLD distance, so an edge is equally
    // soft on every track whatever the light frustum ended up sized to. (The
    // soft edge's real WIDTH comes from the bake blur; this is the depth window
    // that reads it out, and the two multiply.) There is no screen-space floor:
    // this runs over the bake's own texel grid, and the map's bilinear filtering
    // carries what a per-pixel fwidth term used to.
    highp float w = kPenumbraWorld * materialParams.shadowDepthScale * k;
    // The depth bias has to cover the ramp's lit-side reach, not just the
    // usual slope-scaled acne guard. A surface that meets its own depth in
    // the map sits at raw = 0; if the bias were smaller than w it would land
    // mid-ramp and every lit surface in the world would go half-dark — which
    // is exactly what happens the first time you widen the penumbra.
    //
    // Taking the max instead of adding w to the shift keeps the ramp CENTRED
    // on the silhouette rather than hanging below it, which would make the
    // shadow recede from its own outline by the full penumbra.
    highp float biasN = max(biasW * materialParams.shadowDepthScale * k, w);
    float vis = smoothstep(-w, w, raw + biasN);
    // ...and fade the whole test out as the surface turns edge-on to the
    // sun. The bias above scales with 1/NoL, but the depth spread inside a
    // texel goes to INFINITY at true grazing, so no finite bias closes the
    // last few degrees. skysnake's loop is the case: a vertical tube with a
    // RAISED KERB along each rim, lit from ~7 degrees off its own surface,
    // so the kerb scallops the wall below it with a comb of tongues.
    //
    // A surface that edge-on receives almost no sun anyway — the term is
    // multiplied by NoL — so a shadow there carries no information and only
    // its artefacts show. Trust the lookup where the light actually lands
    // (NoL 0.40 is 24 degrees above grazing; a road deck under an overpass
    // sits at 0.98 and is untouched) and let it go where it does not.
    return mix(1.0, vis, smoothstep(0.05, 0.40, NoL));
}

// The world-space entry point. NO PERSPECTIVE DIVIDE: the light is an ORTHO
// camera and the bias matrix folded into shadowFromWorld is a scale and a
// translate, so w is exactly 1. No normal offset either: ESM's bias is inherent
// (equal depths give exp(0) = 1), and nudging the sample along the normal would
// only detach the shadow from whatever cast it.
//
// `wp` MUST be getUserWorldPosition(), not getWorldPosition(): Filament renders
// camera-relative, so the latter is offset by the camera and the lookup would
// slide across the map. The symptom is a surface uniformly in shadow, which
// reads as "the compare is inverted" and is not.
float sunVisibility(highp vec3 wp, float NoL) {
    return sunVisibilityUV((materialParams.shadowFromWorld * vec4(wp, 1.0)).xyz, NoL);
}
