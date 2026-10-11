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
// a static surface's light is vertex data and its sun shadow is one tap into a
// BAKED visibility map, or nothing. The ESM decode lives in ttp_sunvis.inc,
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

// Ambient + sun for a matte surface of colour `base` with world normal `n`, for
// a surface that MOVES (so nothing about its light can be baked) and receives no
// sun shadow. Returns the value that goes into material.emissive — unlit ADDS
// emissive to baseColor, so all the shading rides here and nothing downstream
// touches it.
vec3 ttpMatteShade(vec3 base, highp vec3 n) {
    float NoL = saturate(dot(n, frameUniforms.lightDirection));
    return base * (ttpMatteAmbient(n) + ttpMatteSunTerm(NoL));
}
