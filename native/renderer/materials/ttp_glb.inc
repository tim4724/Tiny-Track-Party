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
