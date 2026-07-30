// The matte shading every lit surface in the scene shares, in ONE place.
//
// This is Filament's own diffuse maths transcribed by hand (see vlit.mat's
// header for why the full PBR `lit` model was dropped), plus the read-out of the
// sun shadow map TtpRenderer bakes once per track. It lives in an include rather
// than in vlit.mat because the ROAD needs the identical shading plus a uv0
// channel and a decal pass, and a second material that re-typed eighty lines of
// measured ESM read-out would drift from this one on the first fix — the exact
// failure this tree keeps designing against.
//
// matc resolves #include relative to the .mat that pulls it in (see
// MaterialCompiler.cpp's resolveIncludes). build-materials.sh's mtime gate is
// extended to treat every .inc here as a dependency of every .mat, so editing
// this file rebuilds all of them.
//
// Anything that reads materialParams must be declared by the INCLUDING material.
// Both vlit.mat and vroad.mat declare the same five shadow parameters, and
// TtpRenderer::bindShadowMap fills them by name on every instance of either.

// Half-width of the shadow's soft edge, in world units. This is a FLOOR on
// the transition, not its width — the bake blur (kPenumbraSigmaWorld) sets
// the width — but at 1.0 it WAS the floor most of the time, and it stopped
// the bake's sigma from buying anything below about half its old value.
//
// 0.6 is a measured optimum, not a round number. Sweeping it against the
// sharpened bake on skysnake's loop: 0.7 gives a 5.0 px edge, 0.6 gives
// 4.6, 0.5 gives 5.4 and 0.45 gives 5.2 — it turns back UP below 0.6,
// because once this drops under the 1.5*fwidth term the ramp is set by a
// screen-space derivative of the recovered depth and picks up its noise
// (normalised roughness 0.070 at 0.6, 0.111 at 0.5). Lowering it also lets
// a shadow reach full black over a smaller gap — the ramp needs
// 2*kPenumbraWorld of depth separation — so pillars and posts read as solid
// contact rather than grey smudges. Watch for acne when changing it: biasN
// below takes the max of the slope bias and this, so it doubles as the
// acne guard on surfaces that face the sun (checked, and 0.6 is clean).
const float kPenumbraWorld = 0.6;

// ONE bilinear tap into the baked, pre-blurred exponential shadow map. The
// penumbra comes from the bake filter (vesm.mat) and the compare below, not
// from taps here — the shipped path went 9 -> 4 -> 1 as each of those moved
// into the bake, and this is the whole runtime cost of a shadow.
//
// Depth is REVERSED [0,1]: 1 at the light, 0 at the far plane. The ortho
// camera's clip z arrives in [-1,1], and bakeShadowMap's bias matrix folds
// it with a NEGATIVE half-scale into that space (see the comment there —
// both halves of this were measured, not assumed). So a caster in front of
// us holds a GREATER stored depth than our own.
//
// `wp` MUST be getUserWorldPosition(), not getWorldPosition(): Filament
// renders camera-relative, so the latter is offset by the camera and the
// lookup would slide across the map as the chase cam moves. The symptom is
// a road uniformly in shadow, which reads as "the compare is inverted" and
// is not.
float sunVisibility(highp vec3 wp, highp vec3 n, float NoL) {
    if (materialParams.shadowTexel <= 0.0) return 1.0;
    // No normal offset: ESM's bias is inherent (equal depths give exp(0) = 1),
    // and nudging the sample along the normal would only detach the shadow
    // from whatever cast it.
    highp vec4 sp = materialParams.shadowFromWorld * vec4(wp, 1.0);
    highp vec3 uv = sp.xyz / sp.w;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0
            || uv.z <= 0.0 || uv.z >= 1.0) return 1.0;
    // ONE bilinear tap. vesm.mat pre-blurred exp(-k·d) at bake time, so the
    // penumbra is already in the texel — no PCF kernel, and the map can be
    // smaller than a filtered depth map would have to be. Equal depths give
    // exp(0) = 1, so the acne bias is inherent and needs no constant.
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
    // staircase. It is also why nothing else moved it: map resolution, blur
    // radius, tap count and cubic reconstruction were each measured, and
    // each left the staircase exactly where it was. They all sharpen a
    // contour that is in the wrong PLACE.
    //
    // -log(occ)/k inverts the exponential and yields the soft-min of the
    // occluder depths under the kernel, which varies smoothly. Comparing
    // THAT, with a modest k (see kShadowEsmK), puts the crossing where the
    // occluder holds roughly half the kernel — its bulk, an average over
    // many texels — and the contour is a smooth curve.
    float occ = texture(materialParams_shadowMap, uv.xy).r;
    highp float dOcc = -log(max(occ, 1e-30)) / materialParams.shadowK;
    highp float raw = uv.z - dOcc;
    // Two floors on the transition width. The first is a fixed WORLD
    // distance, so an edge is equally soft on every track whatever the light
    // frustum ended up sized to. The second is analytic antialiasing —
    // fwidth is how far the comparison moves in one screen pixel, so 1.5 of
    // those keeps the ramp a few pixels wide however close the camera gets
    // or however steeply the occluder towers over the receiver. (The soft
    // edge's real WIDTH comes from the bake blur; this is the depth window
    // that reads it out, and the two multiply.)
    highp float w = max(kPenumbraWorld * materialParams.shadowDepthScale,
                        1.5 * fwidth(raw));
    // The depth bias has to cover the ramp's lit-side reach, not just the
    // usual slope-scaled acne guard. A surface that meets its own depth in
    // the map sits at raw = 0; if the bias were smaller than w it would land
    // mid-ramp and every lit surface in the world would go half-dark — which
    // is exactly what happens the first time you widen the penumbra.
    //
    // Taking the max instead of adding w to the shift keeps the ramp CENTRED
    // on the silhouette rather than hanging below it. Hanging it below is
    // also acne-free, but it makes the shadow recede from its own outline by
    // the full penumbra; centring halves that, and on a track this bias is
    // usually the slope term anyway, so it costs nothing most of the time.
    highp float biasN = max(biasW * materialParams.shadowDepthScale, w);
    float vis = smoothstep(-w, w, raw + biasN);
    // ...and fade the whole test out as the surface turns edge-on to the
    // sun. The bias above scales with 1/NoL, but the depth spread inside a
    // texel goes to INFINITY at true grazing, so no finite bias closes the
    // last few degrees. skysnake's loop is the case: a vertical tube with a
    // RAISED KERB along each rim, lit from ~7 degrees off its own surface,
    // so the kerb scallops the wall below it with a comb of tongues. They
    // are arguably real, and they look like noise.
    //
    // A surface that edge-on receives almost no sun anyway — the term is
    // multiplied by NoL — so a shadow there carries no information and only
    // its artefacts show. Trust the lookup where the light actually lands
    // (NoL 0.40 is 24 degrees above grazing; a road deck under an overpass
    // sits at 0.98 and is untouched) and let it go where it does not.
    return mix(1.0, vis, smoothstep(0.05, 0.40, NoL));
}

// Ambient + sun for a matte surface of colour `base` with world normal `n`.
// Returns the value that goes into material.emissive — unlit ADDS emissive to
// baseColor, so all the shading rides here and nothing downstream touches it.
vec3 ttpMatteShade(vec3 base, highp vec3 n) {
    // Ambient: the 2-band SH the C++ builds from theme.hemi, evaluated
    // exactly as Irradiance_SphericalHarmonics does (Fd_Lambert is already
    // baked into the SH coefficients, hence no 1/PI here).
    vec3 ambient = max(frameUniforms.iblSH[0]
            + frameUniforms.iblSH[1] * n.y
            + frameUniforms.iblSH[2] * n.z
            + frameUniforms.iblSH[3] * n.x, vec3(0.0)) * frameUniforms.iblLuminance;

    // lightDirection is the surface→light vector; .w carries the exposure.
    float NoL = saturate(dot(n, frameUniforms.lightDirection));
    float visibility = sunVisibility(getUserWorldPosition(), n, NoL);
    vec3 sun = frameUniforms.lightColorIntensity.rgb
            * (frameUniforms.lightColorIntensity.w * NoL * visibility * (1.0 / PI));

    return base * (ambient + sun);
}
