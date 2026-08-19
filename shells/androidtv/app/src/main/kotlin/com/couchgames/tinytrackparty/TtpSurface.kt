package com.couchgames.tinytrackparty

import android.view.Surface

/**
 * The two natives that are NOT generated, and the one place this shell hands the
 * engine a platform object.
 *
 * `ttp_display_create` takes a `const char*` because on the web that is a CSS
 * selector, and Kotlin cannot manufacture an `ANativeWindow*` to pass in its
 * place. `ANativeWindow_fromSurface` needs a `JNIEnv` and a `jobject`, so JNI is
 * not a wrapper around the entry point here — it IS the entry point. Both bodies
 * live in `native/runtime/ttp_display_android.cc` beside the rest of the
 * platform surface, bound by classic name mangling rather than the generated
 * RegisterNatives table so that regenerating the bridge can never silently drop
 * the one function without which nothing draws.
 *
 * The tvOS shell's counterpart is `ttp_display_create_layer`, and its header
 * makes the same argument about not spelling a pointer cast at the call site.
 */
internal object TtpSurface {

    /**
     * Bind the engine to a live [Surface]. `width`/`height` are the surface's
     * PHYSICAL pixels and must equal the buffer size the holder was given — the
     * two are what `ttp_display_cell_rects` answers in, so a disagreement puts
     * every HUD chip off the picture it labels.
     */
    external fun nativeCreate(surface: Surface, width: Int, height: Int): Boolean

    /**
     * Tear the display down. The caller removes its Choreographer callback
     * FIRST: `Engine::destroy` touches the window, and a frame in flight while
     * the swap chain goes is a native crash rather than a dropped frame.
     */
    external fun nativeDestroy()
}
