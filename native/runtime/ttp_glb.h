// ttp_glb.h — the two GLB container reads a shell needs before it can provide
// the renderer its bytes. Marshalling over libttp-runtime's ttp/glb.h.
//
// A SIBLING of ttp_display.h rather than part of it, and the split is the same
// one the whole tree runs on: nothing here touches Filament or a surface, so
// this compiles and is ctested on EVERY leg, including the ones with no
// Filament SDK. ttp_display.h's exports live behind that gate; these do not.
//
// What they replaced was ~45 lines of GLB byte surgery in `render/Display.js` —
// the last piece of scene preparation each new shell would have had to write
// again, complete with a padding rule that is invisible until cgltf rejects a
// whole model (ttp/glb.h says which).
#ifndef TTP_GLB_H
#define TTP_GLB_H

#include <stdint.h>

#include "ttp_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/* A 50%-alpha, single-sided clone of a GLB — what the renderer's fade instances
 * (car ghosts, the monster's occlusion twin, the item box's collect fade) are
 * built from. Hand the result straight to ttp_display_asset under the ghost's
 * name.
 *
 * Returns the bytes and writes their length to *outLen. NULL with *outLen 0
 * when the input is not a GLB whose first chunk is JSON — provide nothing and
 * the renderer falls back exactly as it does for a missing asset.
 *
 * The buffer is the usual ABI scratch (ttp_abi.h): valid until the NEXT call to
 * this function, so copy or hand it over before deriving another ghost. */
TTP_ABI const uint8_t* ttp_glb_ghost(const uint8_t* bytes, uint32_t len, uint32_t* outLen);

/* Every images[].uri the container references, as a JSON array of strings, in
 * file order and deduplicated (data: URIs omitted — they carry their own bytes).
 *
 * These have to be provided BEFORE the renderer parses the model: gltfio
 * resolves an external texture by its exact URI string out of what the shell has
 * already handed over. Relative, as authored ("Textures/colormap.png");
 * resolving one against an origin or a bundle is the shell's job.
 *
 * Scratch, per ttp_abi.h. "[]" for an unparseable container. */
TTP_ABI const char* ttp_glb_image_uris(const uint8_t* bytes, uint32_t len);

#ifdef __cplusplus
}
#endif

#endif /* TTP_GLB_H */
