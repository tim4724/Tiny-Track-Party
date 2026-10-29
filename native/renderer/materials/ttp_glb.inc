// The half of the kit's GLB shading that vglb.mat, vglbfade.mat and
// vglbflat.mat share: the base colour, read the way gltfio expects it to be read.
//
// They are separate materials because Filament bakes the BLENDING MODE and the
// INTERPOLATION into a material: the solid kit is opaque, the ghost twins glb.cc
// rewrites are alphaMode BLEND, and the welded flat bodies interpolate flat. The
// base colour is the same in all three, and this is it. What each still spells
// out for itself is its PARAMETER BLOCK, because matc resolves #include inside
// the shader blocks and not inside the material header; vglb.mat carries the
// note on why those names are a contract with gltfio rather than a choice, and
// the other two point at it.
vec4 ttpGlbBaseColor() {
    // Row-vector order, matching gltfio's own materials — matrixFromUvTransform
    // builds it to be applied that way round. Identity for everything this kit
    // ships (see vglb.mat), but the flag that asks for it is set on all of them.
    highp vec2 uv = (vec3(getUV0(), 1.0) * materialParams.baseColorUvMatrix).xy;
    // DISPLAY SPACE, both halves (TtpRendererImpl.h): the atlas is bound as
    // plain RGBA8 (TtpRenderer's texture provider), so the sample IS its sRGB
    // bytes, and the factor was encoded by displayKitFactors when gltfio set
    // it (every later writer encodes its own). An untextured glTF material
    // gets a white 1x1 here and rides on its factor.
    return materialParams.baseColorFactor * texture(materialParams_baseColorMap, uv);
}
