// The half of the kit's GLB shading that vglb.mat and vglbfade.mat share: the
// base colour, read the way gltfio expects it to be read.
//
// The two materials exist only because Filament bakes the BLENDING MODE into a
// material — the solid kit is opaque, the ghost twins glb.cc rewrites are
// alphaMode BLEND — and everything else about them is identical. This is that
// everything else. What each still spells out for itself is its PARAMETER BLOCK,
// because matc resolves #include inside the shader blocks and not inside the
// material header; vglb.mat carries the note on why those names are a contract
// with gltfio rather than a choice, and vglbfade.mat points at it.
vec4 ttpGlbBaseColor() {
    // Row-vector order, matching gltfio's own materials — matrixFromUvTransform
    // builds it to be applied that way round. Identity for everything this kit
    // ships (see vglb.mat), but the flag that asks for it is set on all of them.
    highp vec2 uv = (vec3(getUV0(), 1.0) * materialParams.baseColorUvMatrix).xy;
    // The atlas is bound as sRGB by gltfio, so this sample is already linear. An
    // untextured glTF material gets a white 1x1 here and rides on its factor.
    return materialParams.baseColorFactor * texture(materialParams_baseColorMap, uv);
}

// THE SEAT MARKS: a player's seat colour as a centre stripe over the body paint
// and on the wheels' rims. CPU cars wear none (the renderer decides which car is
// whose; vglb.mat only reads the colour).
//
// The atlas is flat swatches (generated/kit_colors.h), so the swatch a texel
// samples says what the surface IS:
//   - body PAINT is the atlas's 0.5..0.75 band, whichever column a model is
//     painted in; column 13 of that band is the GLASS.
//   - the RIM is the wheel's slate (5) and white (9) swatches inside 0.062 of
//     the wheel node's origin. The bodies use the same two swatches for lights
//     and trim, but never that close to their own origin.
// `p` is the MODEL-space position: the stripe is centred on the car's own axis
// and the rim circle on the wheel's, whatever the node transforms do.
// `fit` is the model's own stripe (ttp/seat_stripe.h measures it): x the
// half-width; the stripe skips p.z > fit.y AND p.y > fit.z, the spoiler.
const float TTP_RIM_R = 0.062;
vec3 ttpSeatMarks(vec3 base, highp vec2 uv, vec3 p, vec3 seat, vec3 fit) {
    // Derivatives first: the branches below split on the SWATCH, which is not
    // uniform across a pixel quad, and a derivative inside one is undefined.
    float r = length(p.yz);
    float wx = fwidth(p.x), wr = fwidth(r);
    float col = floor(uv.x * 16.0);
    if (uv.y >= 0.5 && uv.y < 0.75 && col != 13.0 && !(p.z > fit.y && p.y > fit.z)) {
        float m = 1.0 - smoothstep(fit.x - wx, fit.x + wx, abs(p.x));
        // The band ramps light to dark down v, like every Kenney paint; the
        // stripe keeps that ramp so it reads as paint, not as a sticker.
        return mix(base, seat * clamp(1.12 - (uv.y - 0.5) * 1.5, 0.72, 1.12), m);
    }
    if (uv.y >= 0.75 && (col == 5.0 || col == 9.0)) {
        return mix(base, seat, 1.0 - smoothstep(TTP_RIM_R - wr, TTP_RIM_R + wr, r));
    }
    return base;
}
