// wasm shell — the thin web edge of ttp_runtime.h. Owns exactly what the
// platform owns: the WebGL2 context on the target <canvas> (created + made
// current BEFORE the Filament engine exists — Filament's PlatformWebGL assumes
// a current context and createSwapChain(nullptr)). All rendering lives in
// libttp-renderer.
#include "ttp_runtime.h"
#include "TtpRenderer.h"

#include <emscripten/emscripten.h>
#include <emscripten/html5_webgl.h>
#include <string>

struct TtpRuntime {
    TtpRenderer* renderer;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context;
};

extern "C" {

EMSCRIPTEN_KEEPALIVE
TtpRuntime* ttp_create(const char* surface, uint32_t width, uint32_t height) {
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    // Mirror filament-js's canvas glue (web/filament-js/extensions.js).
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = false;
    attrs.depth = true;
    attrs.stencil = false;
    attrs.antialias = false;
    // Keep the drawing buffer readable after present: the compare gallery's
    // pixel diff reads this canvas back, and a beginFrame frame-skip would
    // otherwise leave it blank at exactly the moment the diff samples it.
    attrs.preserveDrawingBuffer = true;
    attrs.enableExtensionsByDefault = true;
    attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;

    const EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx =
            emscripten_webgl_create_context(surface, &attrs);
    if (ctx <= 0) return nullptr;
    if (emscripten_webgl_make_context_current(ctx) != EMSCRIPTEN_RESULT_SUCCESS) {
        emscripten_webgl_destroy_context(ctx);
        return nullptr;
    }

    auto* renderer = new TtpRenderer();
    if (!renderer->init(filament::backend::Backend::OPENGL, nullptr,
                width, height)) {
        delete renderer;
        emscripten_webgl_destroy_context(ctx);
        return nullptr;
    }
    return new TtpRuntime{ renderer, ctx };
}

EMSCRIPTEN_KEEPALIVE
void ttp_resize(TtpRuntime* rt, uint32_t width, uint32_t height) {
    if (rt) rt->renderer->resize(width, height);
}

EMSCRIPTEN_KEEPALIVE
int ttp_provide_asset(TtpRuntime* rt, const char* name,
        const uint8_t* bytes, uint32_t len) {
    if (!rt) return 1;
    return rt->renderer->provideAsset(name, bytes, len) ? 0 : 1;
}

EMSCRIPTEN_KEEPALIVE
int ttp_build_scene(TtpRuntime* rt) {
    if (!rt) return 1;
    return rt->renderer->buildScene() ? 0 : 1;
}

// Diagnostic: the last frame's per-section wall clock. Returns a pointer into
// the renderer's own array (kProfCount doubles) and, via `names`, a NUL-
// terminated list of section names as one comma-joined string.
EMSCRIPTEN_KEEPALIVE
const double* ttp_profile(TtpRuntime* rt) {
    return rt ? rt->renderer->profile() : nullptr;
}

EMSCRIPTEN_KEEPALIVE
const char* ttp_profile_names() {
    static std::string joined;
    if (joined.empty()) {
        for (const char* const* n = TtpRenderer::profileNames(); *n; ++n) {
            if (!joined.empty()) joined += ',';
            joined += *n;
        }
    }
    return joined.c_str();
}

EMSCRIPTEN_KEEPALIVE
void ttp_release_scene(TtpRuntime* rt) {
    if (rt) rt->renderer->releaseScene();
}

EMSCRIPTEN_KEEPALIVE
int ttp_submit_frame(TtpRuntime* rt, const TtpFrameInput* input) {
    if (!rt || !input) return 0;
    return rt->renderer->render(*input) ? 1 : 0; // 0 = frame skipped, canvas stale
}

EMSCRIPTEN_KEEPALIVE
void ttp_destroy(TtpRuntime* rt) {
    if (!rt) return;
    delete rt->renderer;
    emscripten_webgl_destroy_context(rt->context);
    delete rt;
}

} // extern "C"
