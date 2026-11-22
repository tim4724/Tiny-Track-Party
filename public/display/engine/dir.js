// The folder beside this file that holds the engine: the glue, the wasm, the
// materials. `native` is the checked-in artifact. In site/ the folder is named
// by a hash of its content and scripts/build-site.mjs rewrites this module to
// say so, which is what lets a deployed engine be cached for good.
export const ENGINE_DIR = 'native';
