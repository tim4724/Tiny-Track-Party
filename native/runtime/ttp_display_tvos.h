// ttp_display_tvos.h — the one tvOS-only entry point, declared beside its .mm.
//
// NOT part of the C ABI in ttp_display.h, which is deliberately identical on all
// three platforms. This exists because ttp_display_create takes a `const char*`
// (a CSS selector, on the platform that shaped the signature) and carries a
// CAMetalLayer* on this one. Reaching it from Swift means
// Unmanaged.passUnretained(layer).toOpaque() reinterpreted to
// UnsafePointer<CChar> — legal, and a cast that reads like a bug forever after.
//
// The ABI's own signature is not changed to suit us: it has live JS callers, and
// ttp_abi.h's rule is that these signatures are documented rather than
// redesigned.
#ifndef TTP_DISPLAY_TVOS_H
#define TTP_DISPLAY_TVOS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Exactly ttp_display_create, with the surface typed as what it actually is on
 * tvOS. Pass the view's CAMetalLayer; width/height are physical pixels
 * (layer.drawableSize). Returns 1 on success, 0 on failure — including when the
 * pointer is not a CAMetalLayer, which Filament would otherwise abort on. */
int ttp_display_create_layer(void* layer, uint32_t width, uint32_t height);

#ifdef __cplusplus
}
#endif

#endif /* TTP_DISPLAY_TVOS_H */
