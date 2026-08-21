package games.couchpad.tinytrack

import android.os.Trace
import android.util.Log
import android.view.Choreographer
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray
import java.nio.ByteOrder

/**
 * The surface, the frame loop, and the render scale. Everything platform about
 * drawing, and nothing about what is drawn.
 *
 * ## One thread
 *
 * **Every engine call happens on the main thread.** Not a convention — the
 * display ABI is a documented singleton whose returns point into per-call
 * scratch, so a second thread reading the HUD while this one draws is a data
 * race with no diagnostic. The tvOS shell gets this for free by being
 * `@MainActor` throughout; here it is a rule, and the way to keep it is that
 * nothing outside this file may call a `ttp_display_*` or `ttp_update`.
 *
 * Main-thread Choreographer rather than a dedicated render thread, matching the
 * arrangement tvOS already holds 60 fps with. A render thread is a later,
 * MEASURED decision.
 *
 * **THE COROLLARY IS THAT COMPOSE SPENDS THIS BUDGET TOO.** Recomposition,
 * measure, layout and draw all run on this thread, in the traversal that follows
 * this callback, out of the same 16.7 ms — and on this CPU a HUD recomposition
 * that reaches layout is 10-30 ms. Anything added to a race-screen composable is
 * a render-loop change; `shells/androidtv/CLAUDE.md` lists the three Compose
 * habits that each cost whole frames here.
 *
 * ## SurfaceView, never TextureView
 *
 * A `SurfaceView` is composited by SurfaceFlinger in its own layer beneath the
 * app window, so Compose draws above it with no blit and no extra copy. That is
 * structurally the same arrangement as the tvOS `CAMetalLayer` under SwiftUI. A
 * `TextureView` would route every frame through the view hierarchy as a texture,
 * which costs a full-screen copy per frame on a GPU that has none to spare.
 */
class DisplayHost(private val view: SurfaceView) : SurfaceHolder.Callback {

    companion object {
        private const val TAG = "DisplayHost"

        /** `Stage.js`'s HUD_TICK_MS. See [onSlowTick]. */
        const val HUD_TICK_NANOS = 160_000_000L

        /**
         * The CEILING, in buffer lines — what a panel is worth rendering at all.
         * Only bites on a panel taller than 4K; every TV this ships to is capped
         * by its own resolution first.
         *
         * THERE IS NO FLOOR CONSTANT HERE, and that is the point of the rungs
         * being line counts: `ttp/render_scale.h`'s bottom rung IS the floor, so
         * "the softest picture we will show" is one number in one place rather
         * than a fraction that meant 360 lines on a 1080p surface and 720 on a
         * 2160p one. NOTHING IS REMEMBERED ACROSS SESSIONS either, on purpose:
         * one bad window (a thermal blip, a cold shader cache) would otherwise
         * ratchet a device into the softest picture for the rest of the party.
         */
        const val MAX_BUFFER_H = 2160

        // ttp_hud.h's layout, which the block itself carries (version + stride)
        // so a reader need not have compiled the struct. These are the offsets
        // that layout implies, asserted against the block's own `stride` on the
        // first read.
        const val HUD_HEADER_BYTES = 16
        const val HUD_SLOT_BYTES = 32
        const val HUD_BLOCK_VERSION = 1
        const val HUD_SLOT_LIVE = 1
        const val HUD_SLOT_FINISHED = 2
        const val HUD_SLOT_TIMED = 4
    }

    /** Set once the engine owns a live surface. Nothing may draw before it. */
    var hasSurface: Boolean = false
        private set

    /**
     * Fired EVERY time a surface comes into existence, not just the first.
     *
     * The first fire is why it exists at all: the coordinator's whole boot —
     * materials, the catalogue, the first scene — needs a display, and a
     * SurfaceView has none until the view tree has laid out, which is after
     * `onCreate` returns. The tvOS twin gets that ordering for free by booting
     * from a `.task` that runs after the view appears.
     *
     * THE LATER FIRES MATTER JUST AS MUCH. `surfaceDestroyed` deletes the
     * TtpRenderer, and the renderer owns the asset map — so a box that went to the
     * home screen and came back has no materials, no models and no scene, and
     * nothing on the roster path rebuilds one: the attract demo's signature check
     * sees an unchanged picture and returns early. The visible symptom is a lobby
     * that looks fine (the paper is Compose) over a dead surface, and then
     * `start refused: scene` when the host presses go.
     */
    var onSurfaceReady: (() -> Unit)? = null

    /** Set once a scene is built; `ttp_display_frame` on an empty scene is legal but blank. */
    var hasScene: Boolean = false
        private set

    /**
     * How many frames the engine has actually PRESENTED — not how many Choreographer
     * callbacks arrived, which is the distinction the frame loop below is built on.
     *
     * The one reader is [Scenarios], and it is what a screenshot waits on: a scene
     * that is BUILT is not a scene that is on the glass. A capture taken the instant
     * the harness finished dressing a screen caught a black surface on the two
     * boards whose last act is `hold(true)` — no further frame is submitted after a
     * hold, so whatever the compositor had at that moment is what stays there, and
     * on this emulator that was a frame behind. Counting presents is the fix the
     * tvOS harness names in its own comment and did not build.
     */
    var framesPresented: Long = 0L
        private set

    /**
     * The buffer size the engine was last told about, in PHYSICAL pixels.
     *
     * This is the denominator for every rect the engine answers with, and it is
     * NOT the view's size: the adaptive scale resizes the buffer underneath
     * while the view keeps its bounds. A HUD that divides by the view is a HUD
     * that drifts the moment the scaler steps.
     */
    // COMPOSE STATE, not plain vars. The HUD converts every engine rect through
    // this width, and it is 0 until the surface exists — so a composition that
    // captured it as an ordinary field read 0 forever and every chip, ordinal and
    // item slot silently failed to place. The steer bars kept drawing (they are
    // the renderer's), which is what made a race look almost right.
    var surfaceWidth: Int by mutableIntStateOf(0)
        private set
    var surfaceHeight: Int by mutableIntStateOf(0)
        private set

    /** The biome the last build resolved to — the boost icon's accent keys off it. */
    var biome: String = ""
        private set

    /**
     * The track the last build meshed. Only the perf readout reads it, and it is
     * not decoration there: cost varies several-fold between circuits, so a
     * sample that does not name its scene cannot be compared with another one.
     */
    var trackId: String = ""
        private set

    private var frameCallback: Choreographer.FrameCallback? = null
    private var lastFrameNanos = 0L
    private var lastSlowTickNanos = 0L

    /** The race tick: one dt, on the main thread, before the scene draws. */
    var onFrame: ((Double) -> Unit)? = null

    /**
     * The ~6 Hz poll that paints the HUD and pushes items.
     *
     * Nothing in the HUD changes faster than a place does — the steer bar moved
     * into the renderer — so this is the cadence the chrome is rebuilt at, and it
     * is genuinely the shell's to pick (`ttp_display.h` says so). The web uses
     * 160 ms; this matches it.
     */
    var onSlowTick: (() -> Unit)? = null

    init {
        view.holder.addCallback(this)
    }

    // -- SurfaceHolder.Callback ---------------------------------------------

    override fun surfaceCreated(holder: SurfaceHolder) {
        // Nothing here. The buffer size is not known until surfaceChanged, and
        // creating the engine against a size we would immediately correct is how
        // a first frame lands at the wrong resolution.
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        if (!hasSurface) {
            if (!TtpSurface.nativeCreate(holder.surface, width, height)) {
                Log.e(TAG, "ttp_display_create failed for ${width}x$height")
                return
            }
            hasSurface = true
            surfaceWidth = width
            surfaceHeight = height
            // NO FULL-SCREEN ANTIALIAS PASS ON THIS PLATFORM. Measured on the
            // reference device at the resolution the scaler actually settles on
            // (960x540), on one of the circuit's expensive open vistas: 3.3 ms
            // of GPU — about one whole rung of render scale. 960x540 with hard
            // edges holds a flat 60 there while 960x540 filtered drops frames,
            // and on flat colour with thick ink outlines the extra pixels beat
            // the filter: the scale ladder makes the upscale an exact whole
            // ratio, whose softening is uniform and still.
            //
            // MEASURE IT AT THE SETTLED RESOLUTION AND ON AN EXPENSIVE FRAME.
            // The pass costs a share of the BUFFER, so a reading taken at 1080p
            // is not this decision, and one taken on a cheap corner prices it at
            // half a millisecond and flatters it.
            Ttp.ttp_display_antialias(0)
            flushPendingAssets()
            start()
            onSurfaceReady?.invoke()
        } else if (width != surfaceWidth || height != surfaceHeight) {
            surfaceWidth = width
            surfaceHeight = height
            Ttp.ttp_display_resize(width, height)
            // `ttp_perf.h`'s resize case. The readout CARRIES the buffer size it
            // was measured at, so a window that straddles a resize is labelled
            // one size and priced at another — and with the scaler free that is
            // once a second, which is exactly the comparison the size is on the
            // line for.
            PerfMonitor.reset()
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        // ORDER. The Choreographer callback goes first: Engine::destroy tears
        // down the swap chain, and a frame in flight while that happens is a
        // native crash rather than a dropped frame.
        stop()
        pendingW = 0; pendingH = 0; pendingSent = false
        if (hasSurface) {
            TtpSurface.nativeDestroy()
            hasSurface = false
            hasScene = false
        }
    }

    // -- the loop -----------------------------------------------------------

    /**
     * How many vsyncs one rendered frame spans: 1 presents every vsync, 2 every
     * other — a LOCKED, evenly-paced half rate. On a 60 Hz TV that is 60 and 30;
     * on a 120 Hz one it is 120 and 60, and 2 is what holds the desired 1080@60
     * there.
     *
     * THE RULE OWNS THIS, not the shell: it is half of the operating point
     * `ttp_display_scale_poll` answers, alongside the resolution, because the
     * two are one decision — halving the rate doubles the budget, and on a box whose
     * cost is ~fixed + per-pixel that more than doubles the pixels a budget
     * buys. [pinVsyncInterval] overrides it for a measurement.
     *
     * Only the RENDER half is paced: the sim still ticks on EVERY vsync, so
     * steering keeps the panel's full cadence and only the picture's latency
     * doubles. The divisor is DECLARED to the readout ([declarePacing]), so the
     * deliberate parity skip is priced as the cadence it is and not as damage.
     */
    private var vsyncInterval = 1
    private var vsyncCount = 0L
    private var pendingDt = 0.0

    /**
     * PIN the present divisor, overriding the rule ([PerfDebug]'s `debug.ttp.hz`).
     * 0 hands it back.
     *
     * A PIN AND NOT A SETTER, because the rate is the rule's now: it is half of
     * the operating point `ttp_display_scale_poll` answers, so a plain setter
     * would be overwritten on the next poll a second later and the knob would
     * look broken.
     * Same shape as [pinScale] beside it.
     */
    fun pinVsyncInterval(n: Int) {
        ratePin = n.coerceIn(0, 4)
        if (ratePin != 0) applyVsyncInterval(ratePin)
    }

    private var ratePin = 0

    private fun applyVsyncInterval(n: Int) {
        // Up to 4: a 240 Hz panel's anchor divisor is 4, and the rule may answer
        // any divisor its own operating points name.
        val v = n.coerceIn(1, 4)
        if (v == vsyncInterval) return
        vsyncInterval = v
        // The window describes the old cadence: a 33 ms present judged against a
        // 16.7 ms history reads as a drop on every frame. Its budget follows the
        // new divisor from here rather than 160 ms later at the HUD tick, so no
        // run of frames is ever priced at a cadence nobody was aiming at.
        declarePacing()
        PerfMonitor.reset()
    }

    private fun start() {
        if (frameCallback != null) return
        lastFrameNanos = 0L
        declarePacing()   // before the first sample reaches the readout
        val cb = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                Choreographer.getInstance().postFrameCallback(this)
                if (!hasSurface) return
                // THE CALLBACK'S OWN CLOCK, beside the three `ttp:` markers below
                // and for the same reason: the renderer's profile stops at
                // `ttp_display_frame`, so every other step on this thread is
                // outside it. atrace can see them in a capture; these three spans
                // put the same split in the READOUT, where a sweep can fold it.
                val tCallback = System.nanoTime()
                // THE READOUT'S CADENCE: elapsed since the PREVIOUS TICK, drawn
                // or not (`ttp_perf.h`), unclamped — `dt` below is clamped, so a
                // tick that spanned three budgets would report as one inside the
                // clamp and the drop count would read zero exactly when it matters.
                //
                // NOT the present-to-present interval the fold derives from
                // `presented`, and not 0 on a skipped tick. Fed presents, `frame` and `drops`
                // describe the PRESENTS — which is what `skips` already says — and
                // one paced 60 Hz panel came out p50 16.7 over 120 samples on the
                // web and 33.3 over 60 here: two incomparable columns of the one
                // bench table this readout is shared for. The FIRST tick has no
                // previous one to measure from and is dropped rather than sent as
                // 0: budgetsMissed reads a 0 as "missed nothing" and it would
                // count as a good frame towards the warm-up that exists to filter
                // boot, leaving this shell warm two frames early where the other
                // two need three (Stage.js gates on rawMs > 0; tvOS substitutes
                // the link's own cadence).
                val tickMs = if (lastFrameNanos == 0L) 0.0
                    else (frameTimeNanos - lastFrameNanos) / 1_000_000.0
                val dt = if (lastFrameNanos == 0L) 0.0
                    // CLAMPED, for the reason the demo's loop clamps: a suspended
                    // app must not resume by simulating the seconds it was away.
                    else minOf((frameTimeNanos - lastFrameNanos) / 1_000_000_000.0, 0.05)
                lastFrameNanos = frameTimeNanos
                // The sim first, then the scene: ttp_display_frame's dt drives
                // the COSMETIC clock only (box bob, cloud drift, skid decay,
                // camera damping), never the sim, which ttp_update owns.
                //
                // THE THREE `ttp:` MARKERS BELOW SPLIT THIS CALLBACK, and they do
                // what the spans above cannot. The spans put this split in the
                // READOUT, where a script folds it; the markers put it on a
                // TIMELINE, where one `atrace ... -a <pkg> gfx view` capture places
                // a dropped frame against Compose's own `Recomposer:*`/`traversal`
                // — and Compose, which runs after we return, is the half no span
                // here reaches. That is how the item-box stutter was found (a cold
                // `SoundPool.play` inside `ttp:sim`), and nothing cheaper could
                // have seen it.
                val tSim = System.nanoTime()
                Trace.beginSection("ttp:sim")
                onFrame?.invoke(dt)
                Trace.endSection()
                // FROM THE MARKER, not from the top of the callback: the harness
                // labels this row `ttp_update`, and the cadence arithmetic above is
                // not that. It lands in `other`, which is where it belongs.
                val simNs = System.nanoTime() - tSim
                // A CHOREOGRAPHER CALLBACK IS NOT A PRESENT, and everything that
                // measures this platform hangs off that distinction. Filament's
                // beginFrame declines when the buffer queue is still full — the GPU
                // is behind — and ttp_display_frame answers 0 for exactly that
                // skip. The callback still arrives on the NEXT VSYNC regardless,
                // because Choreographer ticks on the display, not on our swap.
                //
                // So counting callbacks reads a hard 60 on a box presenting 15,
                // which is not a small inaccuracy: the adaptive render scale's one
                // signal on this platform is LATE PRESENTS, and fed vsync ticks it
                // sees a perfect cadence and never rescues anything. The web is not
                // exposed to this (rAF is throttled by presentation) and neither is
                // tvOS (the display link is), so this is Android's alone.
                vsyncCount++
                pendingDt += dt
                var presented = false
                if (pendingW != 0) {
                    // A resize is armed. PERFORM IT AT THE TOP OF THIS CALLBACK
                    // and render in the same one — the latch below clears here so
                    // the frame goes out with it.
                    //
                    // That pairing is the whole point. `setBuffersGeometry` frees
                    // the queue's buffers, so between the call and our next
                    // submission the compositor has NOTHING to show: a gap here is
                    // a black frame, not a stale one. Performing it where a render
                    // immediately follows is what keeps the gap under a vsync.
                    //
                    // WHAT IS LEFT IS ACCEPTED. An occasional small glitch still
                    // shows at a step, and the two ways to remove it both cost
                    // frame rate on the box that needs the render scale most: a
                    // fixed-size swapchain with internal scaling measured ~+3 ms
                    // at 540p output and would take the upscale off the display's
                    // free hardware scaler, and putting the drain back on this
                    // path halved the frame rate through a move (median 23 fps
                    // against 40). DECIDED: the glitch is cheaper than either
                    // cure. Do not trade performance for it.
                    if (pendingW != surfaceWidth || pendingH != surfaceHeight) {
                        if (TtpSurface.nativeSetBufferSize(pendingW, pendingH)) {
                            surfaceWidth = pendingW
                            surfaceHeight = pendingH
                        } else {
                            // No window, or a driver that will not take the
                            // geometry. `setFixedSize` still gets there, at one
                            // mis-scaled frame per move — and it keeps the drain,
                            // which stops a frame recorded at the old viewport
                            // dequeuing a buffer at the new size. `surfaceChanged`
                            // lands inline from it on the reference box.
                            if (!pendingSent) { Ttp.ttp_display_drain(); pendingSent = true }
                            view.holder.setFixedSize(pendingW, pendingH)
                        }
                    }
                    if (pendingW == surfaceWidth && pendingH == surfaceHeight) {
                        pendingW = 0; pendingH = 0; pendingSent = false
                    }
                }
                if (pendingW == 0 && vsyncCount % vsyncInterval == 0L) {
                    Trace.beginSection("ttp:render")
                    presented = Ttp.ttp_display_frame(pendingDt) != 0
                    Trace.endSection()
                    // Consumed either way: the cosmetic clock advances before
                    // beginFrame can decline, so re-feeding it would double-run
                    // the idle animations on the next call.
                    pendingDt = 0.0
                    if (presented) framesPresented++
                }
                // The knob poll and the pacing declaration are inside the SPAN
                // though outside the marker: they are binder traffic on the frame
                // thread at the same rate as the HUD, and a map of the callback
                // that leaves them out has to explain a gap.
                var slowNs = 0L
                if (frameTimeNanos - lastSlowTickNanos >= HUD_TICK_NANOS) {
                    lastSlowTickNanos = frameTimeNanos
                    val tSlow = System.nanoTime()
                    Trace.beginSection("ttp:slowTick")
                    onSlowTick?.invoke()
                    Trace.endSection()
                    PerfDebug.poll(this@DisplayHost)
                    declarePacing()
                    slowNs = System.nanoTime() - tSlow
                }
                // ONE WINDOW, TWO READERS: the readout draws it and the scale
                // rule steers off it. The fold answers both series, so the tick
                // cadence below is all this callback owes either of them.
                if (tickMs > 0) {
                    // `callback` stops HERE, so the monitor's own fold and
                    // `adaptScale` are outside it — an instrument must not be in
                    // its own measurement. Everything before it is in.
                    PerfMonitor.record(frameTimeNanos / 1_000_000.0, tickMs, presented,
                        cellCount, surfaceWidth, surfaceHeight, trackId,
                        simNs / 1_000_000.0, slowNs / 1_000_000.0,
                        (System.nanoTime() - tCallback) / 1_000_000.0)
                }
                adaptScale(frameTimeNanos)
            }
        }
        frameCallback = cb
        Choreographer.getInstance().postFrameCallback(cb)
    }

    private fun stop() {
        frameCallback?.let { Choreographer.getInstance().removeFrameCallback(it) }
        frameCallback = null
    }

    // -- scenes -------------------------------------------------------------

    /**
     * Build a scene. Returns false if the build was refused, which is a real
     * possibility (an unknown track id) and not an assertion.
     */
    fun build(trackId: String, roster: List<RosterSlot>, store: AssetStore): Boolean {
        return try {
            biome = SceneStaging.build(trackId, roster, this, store)
            this.trackId = trackId
            hasScene = true
            // A NEW SCENE VOIDS THE SCALE'S MEASUREMENTS — the same argument as
            // the clear on a scale move, one level up: the windows describe a
            // scene that no longer exists.
            //
            // The scale's own TENURE is not voided here, and this shell no
            // longer decides what a fresh scene is worth. It hands over WHEN the
            // scene was built and the rule shortens the up-hold itself
            // (kScaleUpRecoverHoldSec) — because the browser is exposed to the
            // identical arithmetic (a floored lobby handing the race a scale it
            // then thaws one rung per lap) and had no mitigation at all while
            // this one lived in Kotlin.
            // The window goes for the reason `ttp_perf.h` names: the lobby
            // attract and a race are different pictures, so a percentile that
            // straddles a build describes neither.
            PerfMonitor.reset()
            Ttp.ttp_display_scale_scene(System.nanoTime() / 1_000_000.0)
            // EVERY BUILD, because a build resets the scale's tenure AND drops the
            // cost model — so a shell rebuilding a scene nothing asked it to
            // rebuild shows up as a scaler that will not settle, and the two are
            // indistinguishable without this line.
            Log.i(TAG, "scene build -> $trackId")
            true
        } catch (e: Exception) {
            Log.e(TAG, "scene build failed", e)
            false
        }
    }

    /**
     * The letterboxed cell rectangles, in SURFACE pixels, top-left origin — the
     * only source for where HUD chrome goes.
     *
     * The array is reused across polls rather than allocated: this is read at
     * the HUD's cadence, and 4 floats per cell is not worth a garbage-collected
     * object six times a second.
     */
    private val cellScratch = FloatArray(4 * 8)

    fun cellRects(): List<CellRect> {
        val n = Ttp.ttp_display_cell_rects(cellScratch, 8)
        if (n <= 0) return emptyList()
        return (0 until n).map { i ->
            CellRect(
                cellScratch[i * 4], cellScratch[i * 4 + 1],
                cellScratch[i * 4 + 2], cellScratch[i * 4 + 3],
            )
        }
    }

    // -- the adaptive render scale -------------------------------------------
    //
    // THE BUFFER IS NOT THE PANEL. `ttp/render_scale.h` decides how big it should
    // be from what the last window of frames cost, so the same build holds 60 fps
    // on a weak TV and stays sharp on a strong one. What a shell owes is the BAND
    // and the panel's period, and nothing else — the window, the percentiles, the
    // fastest present, the cost model and the clocks are all
    // `ttp/render_scale_controller.h`'s, folded off the same monitor
    // [PerfMonitor] feeds. If you find yourself writing an `if` around a
    // measurement before passing it, it belongs in that header instead.
    //
    // THIS PLATFORM HAS BOTH SIGNALS, and the rule picks. The good one is GPU
    // milliseconds, the only measurement that can see HEADROOM — a vsync plateau
    // looks identical at 10% and 95% load, so without it the rule may only ever
    // step DOWN and a box that is running fine can never climb back. It comes
    // from `ttp_display_gpu_ms`, which is the GL backend's own
    // EXT_disjoint_timer_query and is REAL here (the CPU-time trap the web
    // documents is emscripten's, and that platform is compiled out of the
    // accessor for exactly this reason). [PerfMonitor] hands it over per frame.
    //
    // IT USED TO KEEP TWO WINDOWS OF ITS OWN, present intervals and GPU
    // milliseconds, with a percentile function of its own that had drifted from
    // the one behind the readout beside it — and it had to, because this shell
    // only fed the monitor while the overlay was up. Both are gone.

    /** Reused, like [cellScratch]: {scale, divisor} back from the poll. */
    private val stepOut = DoubleArray(2)

    /**
     * The panel's OWN present period in milliseconds — one vsync, not one frame.
     *
     * Read live rather than cached: an Android TV box changes HDMI mode under a
     * running app (the manifest declares `screenSize|density|uiMode` in
     * configChanges for exactly that), and a 60 Hz period remembered across a
     * switch into a 120 Hz mode would price every rate decision wrong. Falls
     * back to 60 Hz, which is what the rule assumes for a 0 anyway.
     */
    private fun panelMs(): Double {
        val hz = view.display?.refreshRate ?: 0f
        return if (hz > 1f) 1000.0 / hz else 1000.0 / 60.0
    }

    /**
     * Declare the OPERATING POINT to the readout: the panel's own present period
     * and the divisor we present at. Both are facts only a shell has, and the
     * budget every share on that readout is measured against follows them —
     * without it a paced box reads red forever (`ttp_perf.h`).
     *
     * Re-declared at the HUD's tick because both halves move under a running app:
     * the divisor from the rule or from `debug.ttp.hz`, the period from an HDMI
     * mode change ([panelMs]).
     */
    private fun declarePacing() = Ttp.ttp_perf_pacing(panelMs(), vsyncInterval)

    /**
     * The panel period AS THE RULE MUST SEE IT — one vsync, times the pin.
     *
     * ONE VSYNC IS THE CONTRACT (`ttp_display.h`), because the rule multiplies by
     * the divisor IT chose when it prices a budget. Folding `vsyncInterval` in
     * would therefore double-count the moment the rule picks a divisor of its
     * own: it would pass 16.7 for a 120 Hz panel already running at 2 and then
     * budget 33.4 for a 8.3 ms frame.
     *
     * THE PIN IS THE EXCEPTION, and it is the only one: `debug.ttp.hz` overrides
     * half of a decision the rule made, and the rule cannot see it. Left
     * undeclared, a pinned 30 Hz box would be priced against a 16.7 ms budget and
     * shredded down the ladder to hold a rate nobody asked for. Declared, it says
     * the true thing — this box presents at 30 Hz — and the rule spends the
     * doubled budget on pixels, which is what pinning a rate is FOR
     * (`perf_stats.h`).
     */
    private fun rulePanelMs(): Double = panelMs() * (if (ratePin > 0) ratePin else 1)

    /** The scale in force. 1.0 is the view's own size — this never supersamples. */
    private var renderScale = 1.0

    /** 0 restores the adaptive rule; anything else holds the buffer there. See [PerfDebug]. */
    private var scalePin = 0.0

    /**
     * A buffer resize armed by [applyScale] and performed at the TOP of a later
     * doFrame, with the frame rendered in that same callback — the frame callback
     * carries the why, and [TtpSurface.nativeSetBufferSize] the mechanism.
     *
     * `pendingSent` belongs to the FALLBACK alone: `setFixedSize` may not be
     * issued from the callback that just recorded a frame, and it wants the drain
     * once rather than per tick while it waits for `surfaceChanged`.
     */
    private var pendingW = 0
    private var pendingH = 0
    private var pendingSent = false

    fun pinScale(scale: Double) {
        scalePin = scale
        // Unpinning puts the ADAPTIVE scale back on the buffer, not the pin: the
        // rule's own value is the one it will keep deciding from.
        applyScale(if (scale > 0) scale else renderScale)
        PerfMonitor.reset()
    }

    private fun adaptScale(nowNanos: Long) {
        if (scalePin > 0) return
        // The band is a fact about THIS surface: the ceiling is the panel's own
        // resolution (never above it — a TV app has nothing to gain from
        // supersampling), and 0 is the floor because the LADDER owns the floor.
        // A number there could only narrow the band further, never reach below
        // the bottom rung, and never mean a different picture than it does on
        // the other two shells.
        val viewH = maxOf(1, view.height)
        val moved = Ttp.ttp_display_scale_poll(
            nowNanos / 1_000_000.0,
            0.0, minOf(1.0, MAX_BUFFER_H.toDouble() / viewH), viewH.toDouble(),
            rulePanelMs(),
            stepOut,
        )
        if (moved == 0) return
        val next = stepOut[0]
        val was = vsyncInterval
        // A PINNED RATE IS NOT THE RULE'S TO MOVE. `debug.ttp.hz` holds the
        // divisor, and [rulePanelMs] is what keeps the rule's budget honest
        // about it — so the answer's rate half is discarded here rather than
        // arbitrated. On a 60 Hz panel it can only ever be 1 anyway: the
        // operating-point list holds no other divisor there.
        if (ratePin == 0 && stepOut[1].toInt() != vsyncInterval) {
            applyVsyncInterval(stepOut[1].toInt())
        }
        // WHAT THE RULE ANSWERED, and in RELEASE too, for the reason the readout
        // itself now shows there: the build with R8 is the one worth measuring,
        // and a line that is absent from it explains nothing about the box you
        // are holding. The numbers it was judged on are on the readout's own
        // line, at the same 1 Hz, which is why they are not repeated here.
        Log.i(TAG, String.format(java.util.Locale.ROOT,
            "point %.2f/%d -> %.2f/%d | panel %.1f ms",
            renderScale, was, next, stepOut[1].toInt(), rulePanelMs()))
        if (next == renderScale) return
        renderScale = next
        applyScale(next)
    }

    /**
     * setFixedSize is the whole resize: it changes the BUFFER the surface presents
     * while the view keeps its bounds, and the resulting `surfaceChanged` is what
     * reaches `ttp_display_resize`. Nothing else calls that directly — one owner
     * for the buffer size, or the two disagree.
     */
    private fun applyScale(scale: Double) {
        // HEIGHT FIRST, width derived from the panel's aspect. Rounding the two
        // axes independently lets a truncated scale land off-grid — a pinned
        // 0.667 on a 1080p panel rounded to 1281x720 — while every buffer this
        // band describes is a line count. 720 lines IS 1280 wide; ask for that.
        val h = maxOf(1, Math.round(view.height * scale).toInt())
        val w = maxOf(1, Math.round(h.toDouble() * view.width / view.height).toInt())
        if (w == surfaceWidth && h == surfaceHeight) {
            pendingW = 0; pendingH = 0; pendingSent = false
            return
        }
        // Locale.ROOT: a German box prints "0,80" otherwise, which is the same
        // trap Copy.seconds carries.
        Log.i(TAG, "render scale -> ${String.format(java.util.Locale.ROOT, "%.2f", scale)} (${w}x$h)")
        // ARMED, NOT PERFORMED, and it must stay that way whichever mechanism
        // does the moving.
        //
        // `adaptScale` calls this at the END of a doFrame, after that tick's
        // frame has already gone. Moving the buffer here leaves the queue
        // reconfigured with nothing submitted until the NEXT callback — and
        // `setBuffersGeometry` frees the old buffers, so what the compositor has
        // to show in that gap is not a stale picture but NO picture. Tried, and
        // it reads as a single BLACK frame at every step. The deferred form
        // performs the move at the TOP of a callback and renders in the same one,
        // so the new buffer is submitted before the gap can be composited.
        pendingW = w
        pendingH = h
        pendingSent = false
        // The window that decided this describes the old buffer.
        PerfMonitor.reset()
    }

    // -- assets --------------------------------------------------------------

    /**
     * Assets provided before a surface existed, replayed once one does.
     *
     * The boot order makes this necessary rather than defensive: the materials are
     * handed over in `boot()`, and `ttp_display_asset` refuses everything while
     * there is no display — but a SurfaceView's `surfaceChanged` does not arrive
     * until the view tree has laid out, which is after `onCreate` returns. Without
     * the queue every `.filamat` is refused at boot and the first scene builds
     * with none of them: `vcolor` fails the build outright, and the rest degrade
     * SILENTLY.
     *
     * A LIST, not a map: the order assets arrive in is the order the renderer
     * wants them, and the materials must land before the first build reads them.
     */
    private val pendingAssets = ArrayList<Pair<String, ByteArray>>()

    /**
     * Hand the renderer one asset's bytes.
     *
     * PREDICATE polarity: 1 is accepted, like every int on this ABI since the
     * polarity zoo was retired (`ttp_abi.h`). Returns true when the bytes were
     * accepted OR queued — a queued asset is not a failure, it is an asset that
     * has not been provided yet.
     */
    fun provideAsset(name: String, bytes: ByteArray): Boolean {
        if (!hasSurface) {
            pendingAssets.add(name to bytes)
            return true
        }
        return Ttp.ttp_display_asset(TtpJson.arg(name), bytes) != 0
    }

    private fun flushPendingAssets() {
        for ((name, bytes) in pendingAssets) {
            if (Ttp.ttp_display_asset(TtpJson.arg(name), bytes) == 0) {
                Log.w(TAG, "ttp_display_asset($name) refused on flush")
            }
        }
        pendingAssets.clear()
    }

    // -- what to draw --------------------------------------------------------

    /** The session whose cars this display draws; 0 between races (an empty track). */
    fun bind(session: Int) = Ttp.ttp_display_bind(session)

    /**
     * The cars that own a split-screen cell, in cell order. Everything else in the
     * field is still drawn — it just has no camera.
     */
    fun setCells(ids: List<EngineId>) {
        val a = JSONArray()
        for (id in ids) a.put(id.boxed())
        Ttp.ttp_display_cells(TtpJson.arg(a.toString()))
        cellCount = ids.size
    }

    /** How many cells the last [setCells] asked for — the perf readout's denominator. */
    var cellCount = 0
        private set

    /** Which cells have a centred card over them — a set bit hides that cell's steer bar. */
    fun cellCards(mask: Int) = Ttp.ttp_display_cell_cards(mask)

    /**
     * Hold the field where it is, with every motion cue zeroed. Two callers: the
     * pause overlay, and the end-of-race fast-forward (which runs the sim to the
     * flag with no rendering, so without a hold the just-finished human's chase
     * camera is seen whipping across the track behind the results glass).
     */
    fun hold(held: Boolean) = Ttp.ttp_display_hold(if (held) 1 else 0)

    /**
     * A rocket detonation, queued for the NEXT frame. The renderer cannot infer
     * these: a rocket that hit a car detonates ON that car and rides it out, while
     * a whiff self-destructs at a track point.
     */
    fun burst(id: EngineId?, s: Double, lat: Double) =
        Ttp.ttp_display_burst(id?.let { TtpJson.arg(it.json) }, s, lat)

    /** Tear the scene down; the engine, views, materials and assets live on. */
    fun release() {
        Ttp.ttp_display_release()
        hasScene = false
    }

    fun camera(mode: Int) = Ttp.ttp_display_camera(mode)

    /**
     * Slot i's car id, in the block's slot order — the other half of the HUD
     * readback, and the ONE owner of that mapping (the built scene's roster).
     */
    val roster: List<EngineId>
        get() = TtpJson.arr(Ttp.ttp_display_slot_ids_json()).let { a ->
            (0 until a.length()).mapNotNull { EngineId.from(a.opt(it)) }
        }

    // -- the packed HUD readback --------------------------------------------

    /** One roster slot's HUD values, as `ttp_hud.h` packs them. */
    data class HudSlot(
        val slot: Int,
        val place: Int,
        val lap: Int,
        val totalLaps: Int,
        /** A `TTP_ITEM_*` CODE, not a string. 0 is an empty slot. */
        val item: Int,
        val finished: Boolean,
        /** Null unless the row is TIMED — a forfeit resolved at the flag has none. */
        val finishTime: Double?,
    )

    private var hudLayoutChecked = false

    /**
     * Read the packed HUD block.
     *
     * A READBACK, not a frame: nothing in it changes faster than a place does, so
     * this is polled at [onSlowTick]'s cadence. The block is the display's own
     * scratch, valid until the next call — everything below copies out of it
     * before returning.
     *
     * Only LIVE slots are returned. A slot no live car claims comes back zeroed
     * rather than stale, which is what stops a Grand Prix swapping tracks under
     * the HUD from painting "0th, lap 0".
     */
    fun hud(): List<HudSlot> {
        val buf = Ttp.ttp_display_hud() ?: return emptyList()
        buf.order(ByteOrder.nativeOrder())
        if (buf.capacity() < HUD_HEADER_BYTES) return emptyList()
        val version = buf.getInt(0)
        val count = buf.getInt(4)
        val stride = buf.getInt(8)
        if (!hudLayoutChecked) {
            hudLayoutChecked = true
            // The block carries its own version and stride precisely so a reader
            // can decode without having compiled the struct. Checking them once is
            // what turns a layout change from silently-wrong numbers into a line
            // in the log on the first poll.
            if (version != HUD_BLOCK_VERSION || stride != HUD_SLOT_BYTES) {
                Log.e(TAG, "HUD block is v$version stride $stride, " +
                    "this reader is v$HUD_BLOCK_VERSION stride $HUD_SLOT_BYTES")
            }
        }
        if (version != HUD_BLOCK_VERSION || stride != HUD_SLOT_BYTES) return emptyList()

        val out = ArrayList<HudSlot>(count)
        for (i in 0 until count) {
            val o = HUD_HEADER_BYTES + i * stride
            if (o + stride > buf.capacity()) break
            val flags = buf.getInt(o + 16)
            if (flags and HUD_SLOT_LIVE == 0) continue
            out.add(
                HudSlot(
                    slot = i,
                    place = buf.getInt(o),
                    lap = buf.getInt(o + 4),
                    totalLaps = buf.getInt(o + 8),
                    item = buf.getInt(o + 12),
                    finished = flags and HUD_SLOT_FINISHED != 0,
                    finishTime = if (flags and HUD_SLOT_TIMED != 0) buf.getDouble(o + 24) else null,
                )
            )
        }
        return out
    }
}

/** A cell's rectangle in surface pixels, exactly as `ttp_display_cell_rects` wrote it. */
data class CellRect(val x: Float, val y: Float, val w: Float, val h: Float)
