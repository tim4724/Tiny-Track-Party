// ttp_display_android.cc — the Android TV shell's SURFACE half of the display
// runtime: the ANativeWindow the Kotlin side owns, and the TtpRenderer
// construction over it. Every other extern "C" body in ttp_display.h is shared
// verbatim across platforms in ttp_display_core.cc — if a line here does not
// touch Android or JNI, it is in the wrong file.
//
// The sibling of ttp_display_web.cc and ttp_display_tvos.mm, exactly as both of
// those predict. The tvOS file's own history is the warning worth repeating: it
// once carried copies of the shared bodies, they drifted the moment the core
// moved, and the app rendered a generation-old picture with a clean build. Do
// not add a body here that ttp_display_core.cc already has.
//
// THE JNI ENTRY POINTS LIVE HERE TOO, unlike every other native the Kotlin side
// binds. Those are generated into ttp_jni.cc from the ABI headers; this pair
// cannot be, because a Kotlin caller cannot manufacture an ANativeWindow*.
// ANativeWindow_fromSurface needs a JNIEnv and a jobject, so JNI is not a
// wrapper around the entry point here — it IS the entry point, and it belongs in
// the file that already names the platform.
//
// THEY ARE NOT AN EXTRA ABI, and that distinction is what the `const void*`
// surface bought. When ttp_display_create typed its parameter as the WEB's case
// this file would have owed a forwarder of its own — the tvOS shell carried
// exactly that (`ttp_display_create_layer`, in its own header) purely to keep an
// ANativeWindow-shaped reinterpret out of the call site. An entry point no
// header declares is one tests/display-surface-split.test.js now refuses.

#include "ttp_display.h"
#include "ttp_display_core.h"

#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <jni.h>

#include "TtpRenderer.h"

namespace {

// WHICH BACKEND the next ttp_display_create builds. Decided in KOTLIN
// (VulkanPolicy — the property override, the canary and the blob-set check all
// need a Context), carried here by the JNI entry point below because
// ttp_display_create's signature is the shared ABI and the backend is this
// platform's private business. Vulkan runs stereo-free: multiview is a
// GL_OVR_multiview2 arrangement.
static bool gUseVulkan = false;

// The platform sliver over the shared core: just the window.
struct AndroidDisplay : ttp::rt::DisplayCore {
    // ACQUIRED, unlike the tvOS layer, which is merely held. A SurfaceHolder can
    // hand back its Surface and destroy the underlying buffer queue while the
    // engine is still tearing down — surfaceDestroyed is a callback, not a
    // promise that nobody else holds a reference — so this keeps the window
    // alive until after Engine::destroy has finished with the swap chain.
    ANativeWindow* window = nullptr;
};

}  // namespace

extern "C" {

int ttp_display_create(const void* surface, uint32_t width, uint32_t height) {
    // ALREADY UP is only success if it is the SAME window. The web and tvOS
    // siblings can answer 1 unconditionally — a canvas selector and a
    // CAMetalLayer are owned by one view for the process's life — but a
    // SurfaceView hands out a NEW ANativeWindow every time its surface is
    // recreated, and answering 1 for a different one leaves the engine drawing
    // into a window nothing presents while the shell records the new size. Every
    // cell rect then describes a buffer that is not on screen.
    if (ttp::rt::displayCore()) {
        auto* live = static_cast<AndroidDisplay*>(ttp::rt::displayCore());
        return live->window == surface ? 1 : 0;
    }

    // const_cast because the ABI's parameter is const and ANativeWindow's API is
    // not; the window is not ours to own either way — the Java Surface holds it.
    auto* window = static_cast<ANativeWindow*>(const_cast<void*>(surface));
    if (!window) return 0;

    // NOT setting the buffer geometry here. The buffer size is the SHELL's,
    // because it is the adaptive render scale's output: ttp_display_scale_poll
    // answers a scale, the shell calls SurfaceHolder.setFixedSize with it, and
    // the resulting surfaceChanged is what reaches ttp_display_resize. Writing a
    // geometry here as well would give the buffer two owners that disagree the
    // first time the scaler steps.
    ANativeWindow_acquire(window);

    auto* renderer = new TtpRenderer();
    // No max-texture query, unlike the web surface. That one reads
    // GL_MAX_TEXTURE_SIZE off a context it made ITSELF before handing Filament a
    // null window; here Filament owns the EGL context and creates it inside
    // init(), so there is nothing current to ask yet. The renderer's conservative
    // default stands, exactly as it does on tvOS.
    //
    // stereoEyes = 2 on the GL arm: the engine is configured for OVR_multiview
    // at creation (Filament allows no later switch) and costs the same as a
    // NONE engine while no stereo view draws — the actual render path is the
    // live ttp_display_multiview switch. GL-only, because only that backend
    // compiles glFramebufferTextureMultiviewOVR, and it needs the SDK built
    // with -S multiview (build-runtime-android.sh aborts with the story).
    if (!renderer->init(gUseVulkan ? filament::backend::Backend::VULKAN
                                   : filament::backend::Backend::OPENGL,
                        window, width, height,
                        /*stereoEyes=*/gUseVulkan ? 0 : 2)) {
        delete renderer;
        ANativeWindow_release(window);
        return 0;
    }
    auto* d = new AndroidDisplay();
    d->renderer = renderer;
    d->window = window;
    d->width = width;
    d->height = height;
    ttp::rt::displayCore() = d;
    return 1;
}

void ttp_display_destroy(void) {
    ttp::rt::DisplayCore*& core = ttp::rt::displayCore();
    if (!core) return;
    // Before the window goes: Engine::destroy tears down the swap chain, which
    // touches it. The caller removes its Choreographer callback first.
    auto* d = static_cast<AndroidDisplay*>(core);  // ttp_display_create made it
    delete d->renderer;
    if (d->window) ANativeWindow_release(d->window);
    delete d;
    core = nullptr;
}

// ---------------------------------------------------------------------------
// The Kotlin-facing surface entry points.
// ---------------------------------------------------------------------------
// Classic JNI name mangling rather than the generated RegisterNatives table,
// and deliberately so: this pair is hand-written, the names carry no
// underscores to mangle, and keeping them out of the generated table means
// regenerating the bridge can never silently drop the one function without
// which nothing draws at all.

JNIEXPORT jboolean JNICALL
Java_games_couchpad_tinytrack_TtpSurface_nativeCreate(
        JNIEnv* env, jclass, jobject surface, jint width, jint height,
        jboolean vulkan) {
    if (!surface) return JNI_FALSE;
    gUseVulkan = vulkan == JNI_TRUE;
    // fromSurface RETURNS an acquired window; ttp_display_create acquires again
    // for its own reference, so this one is released either way below.
    ANativeWindow* window = ANativeWindow_fromSurface(env, surface);
    if (!window) return JNI_FALSE;
    const int ok = ttp_display_create(window, (uint32_t) width, (uint32_t) height);
    ANativeWindow_release(window);
    return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_games_couchpad_tinytrack_TtpSurface_nativeDestroy(JNIEnv*, jclass) {
    ttp_display_destroy();
}

// Resize the BUFFER without touching the VIEW's requested size — the adaptive
// render scale's move, done in one place instead of two that can disagree.
//
// `SurfaceHolder.setFixedSize` changes what the SurfaceView asks for, and the
// relayout that follows writes a SCALE onto the layer in a transaction that
// applies at once, while the buffer it describes arrives a frame later. Read off
// the running box, that is layer `tr=[2.00,0.00][0.00,2.00]` against a source
// crop still 960x540 — one composited frame of the picture at the wrong size.
// Rendering sooner cannot close it: at four cells a frame costs more than a
// vsync, so we always miss the next latch.
//
// setBuffersGeometry changes only what the PRODUCER dequeues. No relayout, no
// transaction, the layer transform stays identity, and SurfaceFlinger derives
// the scale from each buffer's own source crop against an unchanged display
// frame. The dimensions travel WITH the buffer, so there is nothing left to be
// out of step.
//
// Answers 0 if there is no window or the driver refuses, and the caller falls
// back to setFixedSize. Kept because this is proven on one box: the EGL surface
// underneath is Filament's, and whether a driver re-reads the geometry of a
// window it has already wrapped is the driver's business, not this file's.
JNIEXPORT jboolean JNICALL
Java_games_couchpad_tinytrack_TtpSurface_nativeSetBufferSize(
        JNIEnv*, jclass, jint width, jint height) {
    ttp::rt::DisplayCore* core = ttp::rt::displayCore();
    if (!core || width <= 0 || height <= 0) return JNI_FALSE;
    auto* d = static_cast<AndroidDisplay*>(core);  // ttp_display_create made it
    if (!d->window) return JNI_FALSE;
    // THE FORMAT IS NOT OPTIONAL AND NEITHER CANDIDATE FOR "leave it alone"
    // works. 0 means "reset to the window's default", which on this box is
    // RGB_565 — measured, one resize took the buffer from RGBA_8888 to
    // `[960x540:2816, RGB_565]`, dropping the whole game to 16-bit colour, which
    // on flat sky-and-sand gradients is banding nobody could miss. And
    // ANativeWindow_getFormat is no better: it answers the window's own default
    // (565 again) rather than the RGBA_8888 the SurfaceView negotiated, so
    // reading it back and handing it in reproduces the bug exactly.
    //
    // So the format the SurfaceView actually uses is named. It is a shell fact
    // and this is the shell's file; `dumpsys SurfaceFlinger` on the setFixedSize
    // path is where it was read.
    if (ANativeWindow_setBuffersGeometry(d->window, width, height,
                                         WINDOW_FORMAT_RGBA_8888) != 0) {
        return JNI_FALSE;
    }
    // The renderer's viewport follows in the same call, so no frame can be
    // recorded against the old one — this is what `surfaceChanged` did on the
    // other path, and there is no surfaceChanged on this one.
    ttp_display_resize((uint32_t) width, (uint32_t) height);
    return JNI_TRUE;
}

}  // extern "C"
