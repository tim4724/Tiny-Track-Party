// ttp_display_web.cc — the WEB shell's SURFACE half of the display runtime:
// the emscripten WebGL2 context on the target <canvas>, and the TtpRenderer
// construction over it. Every other extern "C" body in ttp_display.h is shared
// verbatim across platforms in ttp_display_core.cc — if a line here does not
// touch emscripten, it is in the wrong file.
//
// The tvOS and Android TV shells are siblings OF THIS FILE ONLY (a
// CAMetalLayer* / ANativeWindow* where the WebGL context is here); they
// compile the same ttp_display_core.cc rather than copying its bodies.

#include "ttp_display.h"
#include "ttp_display_core.h"

#include <emscripten/emscripten.h>
#include <emscripten/html5_webgl.h>
#include <GLES3/gl3.h>

#include "TtpRenderer.h"

namespace {

// The platform sliver over the shared core: just the context handle.
struct WebDisplay : ttp::rt::DisplayCore {
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = 0;
};

}  // namespace

extern "C" {

int ttp_display_create(const void* surface, uint32_t width, uint32_t height) {
    if (ttp::rt::displayCore()) return 1;

    // The web is the one platform whose surface IS a string: a CSS selector for
    // the target <canvas>. The ABI types it opaquely because the other two pass
    // a window handle (ttp_display.h), so the cast back lives here, in the file
    // that knows what this platform meant.
    const char* selector = static_cast<const char*>(surface);

    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    // Mirror filament-js's canvas glue (web/filament-js/extensions.js).
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = false;
    attrs.depth = true;
    attrs.stencil = false;
    attrs.antialias = false;
    // Keep the drawing buffer readable after present: the gallery's still
    // capture reads this canvas back, and a beginFrame frame-skip would
    // otherwise leave it blank at exactly the moment the capture samples it.
    attrs.preserveDrawingBuffer = true;
    attrs.enableExtensionsByDefault = true;
    attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;

    // The context must exist and be current BEFORE the Filament engine does —
    // PlatformWebGL assumes a current context and createSwapChain(nullptr).
    const EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_create_context(selector, &attrs);
    if (ctx <= 0) return 0;
    if (emscripten_webgl_make_context_current(ctx) != EMSCRIPTEN_RESULT_SUCCESS) {
        emscripten_webgl_destroy_context(ctx);
        return 0;
    }

    auto* renderer = new TtpRenderer();
    // The real device limit, not an assumed floor: the skid layer's s-axis
    // density is capped by texture width, and 16384 (universal on desktop and
    // recent mobile GPUs) doubles it over the conservative 8192 default.
    GLint maxTex = 0;
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTex);
    if (maxTex > 0) renderer->setMaxTextureDim((uint32_t) maxTex);
    if (!renderer->init(filament::backend::Backend::OPENGL, nullptr, width, height)) {
        delete renderer;
        emscripten_webgl_destroy_context(ctx);
        return 0;
    }
    auto* d = new WebDisplay();
    d->renderer = renderer;
    d->context = ctx;
    d->width = width;
    d->height = height;
    ttp::rt::displayCore() = d;
    return 1;
}

void ttp_display_destroy(void) {
    ttp::rt::DisplayCore*& core = ttp::rt::displayCore();
    if (!core) return;
    auto* d = static_cast<WebDisplay*>(core); // ttp_display_create made it
    delete d->renderer;
    emscripten_webgl_destroy_context(d->context);
    delete d;
    core = nullptr;
}

}  // extern "C"
