// ttp_display_tvos.mm — the tvOS shell's SURFACE half of the display runtime:
// the CAMetalLayer the Swift side owns, and the TtpRenderer construction over
// it. Every other extern "C" body in ttp_display.h is shared verbatim across
// platforms in ttp_display_core.cc — if a line here does not touch Metal or
// UIKit, it is in the wrong file.
//
// The sibling of ttp_display_web.cc, exactly as that file's header predicts
// (a CAMetalLayer* where the WebGL context is there). This file once carried
// its own copies of the shared bodies — written before the core split landed —
// and they drifted the moment the core moved: the lib linked fine, the app
// rendered, and the picture was quietly a generation behind the web's. The
// split exists so that cannot happen; do not add a body here that core has.
//
// .mm rather than .cc — the web file's own comment predicted
// `ttp_display_tvos.cc` and it was wrong. Filament's MetalSwapChain asserts
// its native window `isKindOfClass:[CAMetalLayer class]`, so the pointer has
// to be produced on the ObjC side of the bridge.
//
// There is NO tvOS-only entry point beside the ABI any more. There used to be
// (`ttp_display_create_layer`, in its own header), for one reason: the ABI
// typed its surface as `const char*`, so reaching it from Swift meant an
// `UnsafePointer<CChar>` reinterpret of a CAMetalLayer at the call site — a
// cast that reads like a bug forever after. The parameter is `const void*` now
// and the forwarder had nothing left to do.

#include "ttp_display.h"
#include "ttp_display_core.h"

#import <QuartzCore/CAMetalLayer.h>

#include "TtpRenderer.h"

// NO PLATFORM SLIVER OVER `DisplayCore`, deliberately. The layer is the VIEW's
// and is never read back here: Filament reads layer.drawableSize live on every
// surface-size query, so a resize is a property write on the Swift side plus the
// shared core's renderer->resize, and a copy of the pointer parked in the core
// would only ever be written. Add one when something below actually reads it.

extern "C" {

int ttp_display_create(const void* surface, uint32_t width, uint32_t height) {
    if (ttp::rt::displayCore()) return 1;

    // const_cast first: __bridge does not strip const, and the layer is not
    // ours to own — the view holds it and outlives the display.
    CAMetalLayer* layer = (__bridge CAMetalLayer*) const_cast<void*>(surface);
    // Filament would hard-abort on a wrong class rather than fail; on a TV the
    // difference between a crash at boot and a black screen with a log line is
    // worth one check.
    if (![layer isKindOfClass:[CAMetalLayer class]]) return 0;

    // The layer's pixelFormat and drawableSize are the VIEW's to set, and both
    // are load-bearing:
    //   - BGRA8Unorm, never the _sRGB variant. vpresent.mat writes an already
    //     sRGB-encoded value (it grades, encodes, then FXAAs) and voverlay.mat
    //     states outright that what it writes IS the on-panel sRGB value. An
    //     sRGB layer would encode the whole picture a second time.
    //   - drawableSize is what Filament reports as the surface size, so it and
    //     the width/height below must agree.
    // Neither `device` nor `framebufferOnly` is set here: Filament sets both
    // when it makes the swap chain.

    auto* renderer = new TtpRenderer();
    // No "make current" step and no context to create — Metal has neither. The
    // native window IS the layer.
    if (!renderer->init(filament::backend::Backend::METAL, (__bridge void*) layer, width, height)) {
        delete renderer;
        return 0;
    }
    auto* d = new ttp::rt::DisplayCore();
    d->renderer = renderer;
    d->width = width;
    d->height = height;
    ttp::rt::displayCore() = d;
    return 1;
}

void ttp_display_destroy(void) {
    ttp::rt::DisplayCore*& core = ttp::rt::displayCore();
    if (!core) return;
    // Before the layer goes: Engine::destroy tears down the MetalSwapChain,
    // which touches it. The caller invalidates its CADisplayLink first.
    delete core->renderer;
    delete core;
    core = nullptr;
}

}  // extern "C"
