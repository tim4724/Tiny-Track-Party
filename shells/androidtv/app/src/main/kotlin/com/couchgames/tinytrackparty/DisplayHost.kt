package com.couchgames.tinytrackparty

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

        /**
         * The frame budget, declared ONCE for this shell — the render scale rule
         * takes a SHARE of it rather than milliseconds precisely so it is not
         * restated in C++, and [PerfMonitor] reads it from here for the same
         * reason. A CONSTANT 60 Hz, deliberately not the panel's real rate: a
         * share is cost over budget and a fixed denominator serves that as well.
         */
        const val BUDGET_MS = 1000.0 / 60.0

        /** `Stage.js`'s HUD_TICK_MS. See [onSlowTick]. */
        const val HUD_TICK_NANOS = 160_000_000L

        /** `Stage.js`'s SCALE_POLL_MS — one window per second. */
        const val SCALE_POLL_NANOS = 1_000_000_000L

        /**
         * The band, in BUFFER LINES. The ceiling is what a 4K panel is worth
         * rendering; the floor the softest picture this game is willing to show.
         * NOTHING IS REMEMBERED ACROSS SESSIONS, on purpose: one bad window (a
         * thermal blip, a cold shader cache) would otherwise ratchet a device
         * into the softest picture for the rest of the party.
         *
         * THE FLOOR IS LOWER THAN THE WEB'S 720, and it is a measurement rather
         * than a preference. The reference box (PowerVR GE9215) costs
         * `fixed + per-megapixel` and the FIXED half is about half the 16.7 ms
         * budget on its own, so no buffer size reaches under it — which is what
         * a floor above the device's reach would have made decorative. 360
         * lines is the lowest line count the flat, high-contrast art still
         * upscales cleanly from, and it leaves the rule somewhere to stand.
         * `shells/androidtv/CLAUDE.md` carries the current curve; do not copy a
         * number here, it will rot.
         */

        const val MAX_BUFFER_H = 2160
        const val MIN_BUFFER_H = 360

        /**
         * The measurement window, in PRESENTED frames. It is ROLLING — see
         * [samplePresent] — and that is the whole point: a percentile is only a
         * statement about a stretch of time, and this one has to describe the
         * stretch the scale is about to be decided for.
         *
         * IT USED TO GROW UNBOUNDED between scale changes, and on a device that
         * settles the scale never changes — so after a minute of racing the p95 was
         * the 95th percentile of several laps, i.e. the most expensive corner on
         * the circuit, and the rule was asked to size the buffer for that corner
         * forever. Cost varies well over 1.5x around a lap here, so the difference
         * is not academic: it is why a box with 40% headroom in the median sat at
         * the softest picture the band allows and never climbed out of it.
         *
         * 120 is [PerfMonitor]'s window and means the same thing — about two
         * seconds at 60 fps and about six at 20, so a slow device still gets a
         * percentile worth the name. The poll runs once a second, so consecutive
         * decisions overlap rather than tile, which is what damps a single
         * expensive corner into a nudge instead of a verdict.
         */
        const val SCALE_WINDOW = 120

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

    /** Slot-ordered ids of the built scene, for mapping the HUD readback back. */
    var rosterIds: List<EngineId> = emptyList()
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
     * How many vsyncs one rendered frame spans: 1 presents every vsync (60 fps
     * on a 60 Hz panel), 2 every other — a LOCKED, evenly-paced 30. Only the
     * render half is paced: the sim still ticks on EVERY vsync, so steering
     * keeps its 60 Hz cadence and only the picture's latency doubles. The
     * adaptive scaler judges its share against the doubled budget and climbs
     * the ladder into the freed headroom — which is the point: this box's cost
     * is ~fixed + per-pixel, so halving the rate more than doubles the pixels
     * a budget buys. Driven by `debug.ttp.hz` (see [PerfDebug]); the deliberate
     * parity skip shows up in [PerfMonitor] as ~50% `skip`, which is honest —
     * those vsyncs really did not present.
     */
    private var vsyncInterval = 1
    private var vsyncCount = 0L
    private var pendingDt = 0.0

    fun setVsyncInterval(n: Int) {
        val v = n.coerceIn(1, 2)
        if (v == vsyncInterval) return
        vsyncInterval = v
        // The old windows describe the old cadence: a 33 ms present judged
        // against a 16.7 ms history reads as a drop on every frame.
        frameMs.clear()
        gpuMs.clear()
        lastSampleNanos = 0L
        PerfMonitor.budgetMs = BUDGET_MS * v
    }

    private fun start() {
        if (frameCallback != null) return
        lastFrameNanos = 0L
        val cb = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                Choreographer.getInstance().postFrameCallback(this)
                if (!hasSurface) return
                val dt = if (lastFrameNanos == 0L) 0.0
                    // CLAMPED, for the reason the demo's loop clamps: a suspended
                    // app must not resume by simulating the seconds it was away.
                    else minOf((frameTimeNanos - lastFrameNanos) / 1_000_000_000.0, 0.05)
                lastFrameNanos = frameTimeNanos
                // The sim first, then the scene: ttp_display_frame's dt drives
                // the COSMETIC clock only (box bob, cloud drift, skid decay,
                // camera damping), never the sim, which ttp_update owns.
                //
                // THE THREE `ttp:` MARKERS BELOW SPLIT THIS CALLBACK, and they are
                // the instrument [PerfMonitor] cannot be. Its `cpu` is the
                // RENDERER's own profile, so everything else on this thread — the
                // sim tick, the event drain, the HUD poll, and every line of Compose
                // that runs after we return — is outside every number it prints. A
                // frame lost up here reads there as a healthy GPU and a mystery.
                // With these, one `atrace ... -a <pkg> gfx view` capture attributes
                // a dropped frame to a phase: `ttp:render` against `ttp:sim` against
                // `ttp:slowTick` against Compose's own `Recomposer:*`/`traversal`.
                // That is how the item-box stutter was found — a cold `SoundPool.play`
                // inside `ttp:sim` — and nothing cheaper could have seen it.
                Trace.beginSection("ttp:sim")
                onFrame?.invoke(dt)
                Trace.endSection()
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
                    // A resize is armed: render nothing this vsync. Drain once
                    // so no recorded frame is still in flight, resize, and keep
                    // holding until surfaceChanged reports the new size back
                    // (setFixedSize is idempotent while we wait). The cost is a
                    // repeated frame per scale move — invisible next to the
                    // mis-scaled frame this replaces.
                    if (pendingW != surfaceWidth || pendingH != surfaceHeight) {
                        if (!pendingSent) { Ttp.ttp_display_drain(); pendingSent = true }
                        view.holder.setFixedSize(pendingW, pendingH)
                    } else {
                        pendingW = 0; pendingH = 0; pendingSent = false
                    }
                } else if (vsyncCount % vsyncInterval == 0L) {
                    Trace.beginSection("ttp:render")
                    presented = Ttp.ttp_display_frame(pendingDt) != 0
                    Trace.endSection()
                    // Consumed either way: the cosmetic clock advances before
                    // beginFrame can decline, so re-feeding it would double-run
                    // the idle animations on the next call.
                    pendingDt = 0.0
                    if (presented) framesPresented++
                }
                if (frameTimeNanos - lastSlowTickNanos >= HUD_TICK_NANOS) {
                    lastSlowTickNanos = frameTimeNanos
                    Trace.beginSection("ttp:slowTick")
                    onSlowTick?.invoke()
                    Trace.endSection()
                    PerfDebug.poll(this@DisplayHost)
                }
                // The RAW interval between PRESENTS, never `dt`: dt is clamped, so a
                // frame that took three budgets would be reported as one that took
                // three within the clamp and the drop count would read zero exactly
                // when it matters.
                val intervalMs = if (presented) samplePresent(frameTimeNanos) else 0.0
                PerfMonitor.record(frameTimeNanos / 1_000_000.0, intervalMs, presented,
                    cellCount, surfaceWidth, surfaceHeight, trackId)
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
     * Build a scene, and record what a HUD readback will need to map slots back
     * to players. Returns false if the build was refused, which is a real
     * possibility (an unknown track id) and not an assertion.
     */
    fun build(trackId: String, roster: List<RosterSlot>, store: AssetStore): Boolean {
        return try {
            biome = SceneStaging.build(trackId, roster, this, store)
            this.trackId = trackId
            rosterIds = roster.map { it.id }
            hasScene = true
            // A NEW SCENE VOIDS THE SCALE'S HISTORY — the same argument as the
            // clear on a scale move, one level up: the windows describe a scene
            // that no longer exists, and so does the up-hold clock. Without
            // this, a lobby that floored the scale (the attract behind the
            // boards is one of the heaviest pictures) hands the race a 640x360
            // buffer that kScaleUpHoldSec then thaws ONE RUNG PER 28 SECONDS —
            // four rungs to the race's own settle, most of a three-lap race
            // spent soft. The clock reset covers the FIRST climb;
            // recoveryClimb (see adaptScale) keeps the tenure at zero while
            // the climb is still finding THIS scene's level, so the whole
            // recovery runs at one evidence window per rung. WHAT to do stays
            // entirely the rule's.
            frameMs.clear()
            gpuMs.clear()
            lastSampleNanos = 0L
            scaleMovedNanos = 0L
            recoveryClimb = true
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
    // on a weak TV and stays sharp on a strong one. What a shell owes is the
    // MEASUREMENT and the BAND, and nothing else — every judgement about those
    // numbers is the rule's. If you find yourself writing an `if` around a
    // measurement before passing it, it belongs in that header instead.
    //
    // THIS PLATFORM HAS BOTH SIGNALS. The good one is GPU share of budget, and it
    // is the only measurement that can see HEADROOM — a vsync plateau looks
    // identical at 10% and 95% load, so without it the rule may only ever step
    // DOWN and a box that is running fine can never climb back. It comes from
    // `ttp_display_gpu_ms`, which is the GL backend's own EXT_disjoint_timer_query
    // and is REAL here (the CPU-time trap the web documents is emscripten's, and
    // that platform is compiled out of the accessor for exactly this reason).
    //
    // Late presents stay as the fallback for a device whose driver has no timer:
    // 0 ms goes over, and the rule reads that as "no signal".


    /** Intervals between PRESENTED frames, in milliseconds. Skips are not frames. */
    private val frameMs = ArrayList<Double>(SCALE_WINDOW)

    /** The backend's GPU milliseconds, one per presented frame, over the same window. */
    private val gpuMs = ArrayList<Double>(SCALE_WINDOW)
    private var lastSampleNanos = 0L
    private var lastScalePollNanos = 0L
    private var scaleMovedNanos = 0L

    /** `ttp_display_present_floor`'s running answer: the device's own fastest present. */
    private var presentFloorMs = 0.0

    /** The scale in force. 1.0 is the view's own size — this never supersamples. */
    private var renderScale = 1.0

    /**
     * True from a scene build until the scale finds THIS scene's level — the
     * first down-step, or the first full-signal poll that answers "stay". The
     * up-hold clock measures how long a scale has been stable IN ONE SCENE, so
     * a scale inherited from a dead scene has no tenure, and keeps none while
     * the post-build climb is still in progress; each recovery rung re-arms
     * nothing. The moment the rule stops climbing, tenure starts counting and
     * kScaleUpHoldSec guards mid-race moves exactly as before.
     */
    private var recoveryClimb = false

    /**
     * Records one PRESENTED frame's interval and hands it back, in milliseconds;
     * 0 for the first. Skipped frames never reach here — see the callback.
     */
    private fun samplePresent(nowNanos: Long): Double {
        val ms = if (lastSampleNanos == 0L) 0.0 else (nowNanos - lastSampleNanos) / 1_000_000.0
        if (ms > 0) frameMs.add(ms)
        lastSampleNanos = nowNanos
        // 0 is "the query has not come back", not "a free frame", so it is dropped
        // rather than folded into a percentile that would then read as headroom.
        val gpu = Ttp.ttp_display_gpu_ms()
        if (gpu > 0) gpuMs.add(gpu)
        // ROLLING, and the two series are trimmed independently BECAUSE they are
        // not parallel: a frame whose timer result has not come back adds an
        // interval and no GPU sample. (PerfMonitor's series ARE parallel — it
        // records a 0 and filters at the read — because it prints them side by
        // side; nothing here compares one to the other.)
        if (frameMs.size > SCALE_WINDOW) frameMs.subList(0, frameMs.size - SCALE_WINDOW).clear()
        if (gpuMs.size > SCALE_WINDOW) gpuMs.subList(0, gpuMs.size - SCALE_WINDOW).clear()
        return ms
    }

    /** 0 restores the adaptive rule; anything else holds the buffer there. See [PerfDebug]. */
    private var scalePin = 0.0

    /**
     * A buffer resize armed by [applyScale], performed by a LATER doFrame — never
     * in the callback that just submitted a frame at the old size. Filament's
     * driver thread executes and DEQUEUES asynchronously, up to a frame behind,
     * so a setFixedSize issued while a frame is in flight can hand that frame a
     * buffer at the NEW size with its viewport still at the OLD one — the scene
     * shrinks into a corner (or crops) for exactly one frame, SurfaceFlinger
     * stretches it, and the glass flickers. The performing doFrame first DRAINS
     * the driver thread (once — ttp_display_drain), then resizes, and submits
     * nothing until surfaceChanged has delivered the new size back.
     */
    private var pendingW = 0
    private var pendingH = 0
    private var pendingSent = false

    fun pinScale(scale: Double) {
        scalePin = scale
        // Unpinning puts the ADAPTIVE scale back on the buffer, not the pin: the
        // rule's own value is the one it will keep deciding from.
        applyScale(if (scale > 0) scale else renderScale)
        frameMs.clear()
        gpuMs.clear()
    }

    private fun adaptScale(nowNanos: Long) {
        if (scalePin > 0) return
        if (nowNanos - lastScalePollNanos < SCALE_POLL_NANOS) return
        lastScalePollNanos = nowNanos
        if (frameMs.isEmpty()) return

        val sorted = frameMs.sorted()
        val p05 = percentile(sorted, 0.05)
        val p95 = percentile(sorted, 0.95)
        // The fastest present is the ONE number carried between windows, so the
        // fold happens here — but WHICH samples may become one is the rule's.
        presentFloorMs = Ttp.ttp_display_present_floor(presentFloorMs, p05)

        val viewH = maxOf(1, view.height)
        // The band is a fact about THIS surface: the ceiling is the panel's own
        // resolution (never above it — a TV app has nothing to gain from
        // supersampling), the floor the softest picture worth showing.
        val max = minOf(1.0, MAX_BUFFER_H.toDouble() / viewH)
        val min = minOf(max, MIN_BUFFER_H.toDouble() / viewH)

        // SHARE OF BUDGET, not milliseconds: the frame budget is declared in the
        // shell that measures it and the rule never restates it (render_scale.h).
        // The interval multiplies it — at every-other-vsync pacing a frame has
        // two periods to land in, and judging it against one would read every
        // healthy 30 fps frame as over budget.
        val gpuShareP95 = percentile(gpuMs.sorted(), 0.95) / (BUDGET_MS * vsyncInterval)

        val next = Ttp.ttp_display_scale_step(
            renderScale,
            gpuShareP95, gpuMs.size,
            // The floor is folded RAW (the panel's own fastest present); what
            // the rule must judge lateness against is the CADENCE WE CHOSE,
            // which is interval x floor — otherwise 30 fps pacing reads as a
            // ratio of 2.0 and the fallback path rescues a healthy device
            // forever downward.
            p95, presentFloorMs * vsyncInterval, frameMs.size,
            (nowNanos - scaleMovedNanos) / 1_000_000_000.0,
            min, max,
        )
        // WHAT THE RULE WAS ASKED, every poll, not just when it answers a move.
        // The interesting case is the one that does NOT move: a box parked at the
        // floor tells you nothing about WHY unless you can see the share it was
        // judged on, and "the scale never climbed" was diagnosed here twice from
        // guesswork before this line existed. Debug builds only, once a second.
        if (BuildConfigIsDebug) {
            Log.i(TAG, String.format(java.util.Locale.ROOT,
                "scale %.2f -> %.2f | gpu p95 %.0f%% of budget over %d frames" +
                    " | present p95 %.1f floor %.1f over %d",
                renderScale, next, gpuShareP95 * 100, gpuMs.size,
                p95, presentFloorMs, frameMs.size))
        }
        if (next == renderScale) {
            // Full signal and the rule chose to stay: the scale has found this
            // scene's level, so its tenure starts now.
            if (recoveryClimb && gpuMs.size >= 30) recoveryClimb = false
            return
        }
        if (next < renderScale) recoveryClimb = false
        renderScale = next
        scaleMovedNanos = if (recoveryClimb) 0L else nowNanos
        // ONLY WHEN THE SCALE ACTUALLY MOVED. The window that just decided this
        // describes the OLD resolution, so keeping it would judge the new one on
        // the old one's frames — but clearing on EVERY poll caps the sample count
        // at "frames drawn in the last second", which is the framerate. The rule
        // ignores a window under kMinSignalFrames (30) because a percentile over a
        // handful of frames is not a percentile, so a box at 20 fps produced 20
        // samples, was told it had no signal, and never stepped down — going deaf
        // in exactly the case the mechanism exists for. The web's `perf.sample()`
        // reads a ROLLING window and resets only after a change, which is what
        // this matches.
        frameMs.clear()
        gpuMs.clear()
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
        pendingW = w
        pendingH = h
        pendingSent = false
    }

    private fun percentile(sorted: List<Double>, q: Double): Double {
        if (sorted.isEmpty()) return 0.0
        val i = ((sorted.size - 1) * q).toInt().coerceIn(0, sorted.size - 1)
        return sorted[i]
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
        rosterIds = emptyList()
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
