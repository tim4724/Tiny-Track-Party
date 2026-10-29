// glb — the two GLB-container reads a SHELL has to do before it can hand the
// renderer bytes, in the one place all three shells can share them.
//
// Neither of these names a platform API, so by the placement rule they were in
// the wrong file: both lived in `public/display/render/Display.js` as browser
// JS, which made them the last pieces of scene preparation a tvOS or Android
// shell would have had to re-derive from prose. The ghost transform in
// particular carries a trap that is invisible until cgltf rejects a whole model
// (see `ghost_glb`), and a bug reproduced independently in three languages is
// exactly what this codebase spends its corpora avoiding.
//
// Why the SHELL does this at all rather than the renderer: the renderer is
// handed bytes under a name and stores them (`TtpRenderer::provideAsset`). What
// bytes exist, and where they come from, is the shell's business — a fetch on
// web, a bundle read on tvOS. These functions only shape what it already holds.
//
// GLB layout (glTF 2.0 §4.4.3): a 12-byte header (magic, version, total
// length), then chunks, each an 8-byte header (length, type) plus payload. The
// JSON chunk is mandatory and first, so its payload always starts at byte 20.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ttp {
namespace rt {

// A 50%-alpha, single-sided clone: every material gets alphaMode BLEND,
// doubleSided false, and its baseColorFactor's alpha set to 0.5.
//
// It is what the renderer's fade instances are built from — the monster truck's
// occlusion ghost, each car's ghost, and the item box's collect fade. Those
// exist because the toy-car kit's own materials are OPAQUE: a solid instance
// cannot be faded at all, so the renderer parks a translucent twin and ramps
// that one's alpha instead. (The 0.5 baked here rarely shows; the renderer
// writes the alpha itself on every frame something is dissolving.)
//
// THE PADDING IS MEASURED IN BYTES, NOT CHARACTERS, and that is the whole trap:
// a chunk must be padded to a 4-byte boundary, a non-ASCII material name
// encodes to more UTF-8 bytes than it has UTF-16 units, and a JSON chunk landing
// off a 4-byte boundary makes cgltf reject the entire file rather than the one
// material. The kit ships ASCII names today, so a length-in-characters bug here
// would pass every model in the tree and fail on the first localized asset.
//
// Returns empty when `bytes` is not a parseable GLB with a JSON chunk; a caller
// that provides nothing just gets the renderer's untextured fallback, which is
// the same outcome the browser had when its `try` caught.
std::vector<uint8_t> ghost_glb(const uint8_t* bytes, size_t len);

// Every `images[].uri` the container references, in file order and deduplicated.
//
// The shell needs these BEFORE the renderer parses the model: gltfio resolves an
// external texture URI out of the assets already provided (`registerAssetUris`
// looks each one up by its exact string), so the bytes must be in place before
// the load runs. `FilamentAsset::getResourceUris()` knows the same answer and is
// unreachable at that point in the sequence — hence a second reader here.
//
// Relative URIs are handed back verbatim (`Textures/colormap.png`); resolving
// one against an origin or a bundle directory is the shell's job. Data URIs are
// skipped: those carry their own bytes and need no provisioning.
std::vector<std::string> glb_image_uris(const uint8_t* bytes, size_t len);

}  // namespace rt
}  // namespace ttp
