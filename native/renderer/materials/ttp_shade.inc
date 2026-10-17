// The matte shading every lit surface in the scene shares, in ONE place.
//
// This is Filament's own diffuse maths transcribed by hand (see vlit.mat's
// header for why the full PBR `lit` model was dropped). It lives in an include
// so the live-lit materials (vlit, vglb, vglbfade) and the baked-light ones
// (vroad, vground, whose vertex stages rebuild the sun term from a baked NoL)
// compose the exact same terms, and the CPU twins in TtpRenderer
// (bakeVertexLight, bakedMatteLight) have one spelling to follow. A fix here
// must reach them.
//
// THE SUN'S SHADOW IS NOT HERE, and that is the rule rather than an omission:
// a static surface's light is vertex data (two display-encoded terms, see
// bakeVertexLight) and its sun shadow is one tap into a BAKED visibility map,
// or nothing. The ESM decode lives in ttp_sunvis.inc,
// which only the bake materials include — nothing samples the ESM in a frame.
//
// matc resolves #include relative to the .mat that pulls it in (see
// MaterialCompiler.cpp's resolveIncludes). build-materials.sh's mtime gate is
// extended to treat every .inc here as a dependency of every .mat, so editing
// this file rebuilds all of them.

// Ambient: the 2-band SH the C++ builds from theme.hemi, evaluated exactly as
// Irradiance_SphericalHarmonics does (Fd_Lambert is already baked into the SH
// coefficients, hence no 1/PI here).
vec3 ttpMatteAmbient(highp vec3 n) {
    return max(frameUniforms.iblSH[0]
            + frameUniforms.iblSH[1] * n.y
            + frameUniforms.iblSH[2] * n.z
            + frameUniforms.iblSH[3] * n.x, vec3(0.0)) * frameUniforms.iblLuminance;
}

// The sun's contribution at FULL visibility; a receiver multiplies its baked
// visibility in. Every term reaches the surface through NoL alone, which is why
// a baked NoL is the whole input. lightColorIntensity.w is the exposure.
vec3 ttpMatteSunTerm(float NoL) {
    return frameUniforms.lightColorIntensity.rgb
            * (frameUniforms.lightColorIntensity.w * NoL * (1.0 / PI));
}

// THE SCENE IS AUTHORED IN DISPLAY SPACE (TtpRendererImpl.h has the whole
// argument): a light term reaches the fragment already exposed and sRGB-encoded,
// the fragment multiplies it into an albedo that is encoded too, and nothing is
// graded per fragment. This is that encode, for the one light the CPU cannot
// bake — a surface that MOVES (vlit, vglb, vglbfade) evaluates its matte light
// in the VERTEX stage and encodes it here. NOT clamped: a sunlit face reaches
// 1.1x and the clip belongs on the product, in the 8-bit scene buffer, where
// the per-fragment grade used to put it. MIRRORED IN C++ as displayLight, and
// the exposure as kGradeExposure (tests/shader-cpp-constants.test.js).
const float TTP_GRADE_EXPOSURE = 1.1;
vec3 ttpDisplayLight(vec3 linear) {
    vec3 c = max(linear * TTP_GRADE_EXPOSURE, vec3(0.0));
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, step(c, vec3(0.0031308)));
}
// The matte light of a moving surface's vertex, encoded: what vlit, vglb and
// vglbfade hand their fragment in fog.yzw.
vec3 ttpMatteLightDisplay(highp vec3 n) {
    float NoL = saturate(dot(n, frameUniforms.lightDirection));
    return ttpDisplayLight(ttpMatteAmbient(n) + ttpMatteSunTerm(NoL));
}
