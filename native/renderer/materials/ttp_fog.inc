// The distance fog, computed PER VERTEX and mixed per fragment.
//
// WHY IT IS OURS AT ALL. Filament composites fog inside every surface shader,
// and on a low-end mobile GPU that was the most expensive thing in the frame:
// measured on a PowerVR GE9215 at 1920x1080 with the backend's own timer, over
// a fixed lobby, 79 ms with it and 60 ms without. Nineteen milliseconds, where a
// whole 60 Hz budget is 16.7 — more than the deck's decal loop, its rubber tap
// and its sun shadow put together. It is not the fog MATHS: Filament's own cheap
// path (`linearFog : true`) recovered barely a third. It is the VARIANT.
// Switching fog on selects a different shader carrying a cubemap sampler for the
// sky-colour option, a transpose(mat3) and a pow() for sun inscattering — both
// behind uniform branches this scene never takes — to run one exponential.
//
// WHY IT IS PER VERTEX. Written per fragment, term for term, it still cost
// 11.5 ms. THE UNIT OF CURRENCY ON THIS GPU IS THE TRANSCENDENTAL: one `exp` or
// one `sqrt` over a full screen is about 3 ms, and radial fog needs both. Per
// vertex they are paid on a few thousand vertices instead of two million
// fragments, and the fragment is left with a `mix`. That is the oldest fog
// implementation there is, and it is the right one here.
//
// THE VALUES ARE STILL FILAMENT'S. `ColorPassDescriptorSet::prepareFog` runs
// whether or not the fog variant does, so these frameUniforms are live with the
// numbers `TtpRenderer::fogFor` chose — nothing is restated, and a fog tuned
// there still lands here.
//
// Included by BOTH the vertex and fragment blocks of every scene material: the
// factor is computed in one and consumed in the other.

// The fog opacity at a world position. Filament's own expression with the two
// branches this scene never enters removed, and with heightFalloff pinned to 0
// (fogFor has always set it so), which collapses the optical path integral to a
// single exponential.
//
// The NEAR exit is Filament's; the FAR one is what keeps the sky dome out of the
// fog it is meant to be dissolving into (fogFor's cutOffDistance).
//
// THE ABLATION SWITCH (TTP_FEAT_FOG_VERTEX) takes .y of the view global
// ttp_grade.inc documents, and it is the only way to price THIS function: the
// existing TTP_FEAT_FOG arm moves fog PARAMETERS, so the `length` and the `exp`
// below are paid either way and no arm could ever see them. That is what made
// "drop the per-vertex sqrt" a proposal nobody could check. Returning 0 here
// skips both transcendentals AND the fragment mix's contribution, so the arm
// measures the whole per-vertex fog term at once.
float ttpFogFactor(highp vec3 worldPos) {
    if (getMaterialGlobal0().y > 0.0) return 0.0;
    highp vec3 view = worldPos - getWorldCameraPosition();
    highp float d = length(view);
    if (d < frameUniforms.fogStart || d > frameUniforms.fogCutOffDistance) {
        return 0.0;
    }
    return min(1.0 - exp(-frameUniforms.fogDensity.z
            * (d - frameUniforms.fogStart)), frameUniforms.fogMaxOpacity);
}

// The fragment half, on DISPLAYED colour — after the grade, which is where
// Filament put it (it ran on fragColor, past evaluateMaterial).
vec3 ttpFogMix(vec3 displayed, float a) {
    return displayed * (1.0 - a)
            + frameUniforms.fogColor * (frameUniforms.iblLuminance * a);
}

// ADDITIVE blending only. Filament zeroes the fog colour for BLEND_MODE_ADD —
// adding a fog colour onto a screen that is already being added to would
// lighten it — so distance may only ever fade an additive flash out.
vec3 ttpFogMixAdd(vec3 displayed, float a) {
    return displayed * (1.0 - a);
}
