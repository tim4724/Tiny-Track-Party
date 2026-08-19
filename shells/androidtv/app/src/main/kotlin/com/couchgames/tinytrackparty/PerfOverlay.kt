package com.couchgames.tinytrackparty

import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.nio.ByteOrder
import java.util.Locale

/**
 * The frame-cost readout, and the Android half of `render/PerfHud.js` and
 * `Render/PerfOverlay.swift`. Read those two first — the reasoning about what a
 * clock here can and cannot mean is written down once, there.
 *
 * THREE CLOCKS, AND THEY DO NOT MEASURE THE SAME THING.
 *
 *  - The PRESENT interval, which is the cadence the TV actually showed. Under
 *    vsync it is a plateau, so it says nothing about headroom, but it is the only
 *    thing that says whether a budget was MISSED, which is the part a human
 *    feels. It counts PRESENTS, not Choreographer callbacks — see [DisplayHost],
 *    because the difference between those two is a readout saying 60 on a box
 *    showing 15, and this shell shipped that way.
 *  - CPU, from `ttp_display_profile`: the C++ building the frame's input from the
 *    live `Game` and issuing its draws. Under two milliseconds here, always.
 *  - GPU, from `ttp_display_gpu_ms` — the GL backend's own timer query, and the
 *    one number that can see headroom. It is REAL on this platform, unlike the
 *    two siblings, both of which say so in their own headers.
 *
 * The costs do NOT sum: the CPU builds frame N's commands while the GPU is still
 * drawing N-1. Whichever is larger is the one to cut, and on this box it has
 * never once been the CPU.
 *
 * WHAT THIS ONE ADDS OVER ITS TWO SIBLINGS is the per-section split, and the
 * reason is a measurement rather than taste: on the web the total is under a
 * millisecond and the sections below it are quantization noise, while here the
 * frame costs tens of milliseconds and WHICH section holds them is the question.
 *
 * ON IN DEBUG BUILDS, and toggled with KEYCODE_INFO — which this box's remote does
 * not carry, so in practice it is `adb shell input keyevent 165`. Everything is
 * inert while hidden: [record] returns before it touches the profile ABI.
 *
 * MAIN THREAD ONLY, like everything that touches a `ttp_display_*`.
 */
object PerfMonitor {

    /**
     * The bar, and the denominator of every percentage. Declared in
     * [DisplayHost], which also OWNS this value: at every-other-vsync pacing
     * (`debug.ttp.hz 30`) it doubles, or every healthy 33 ms frame would read
     * as a drop and every percentage would lie by 2x.
     */
    var budgetMs = DisplayHost.BUDGET_MS
    /**
     * The cost stats fold at most this many frames, AND at most [WINDOW_MS] of
     * them. The frame cap alone is a trap on a slow box, and it cost a whole
     * ablation sweep: 120 frames at 12 fps is TEN SECONDS of history, so every
     * arm of the sweep read as a blend of itself and the arm before it — which
     * is exactly the situation the readout is for. The time bound is what makes
     * a reading describe the last few seconds at any frame rate.
     */
    private const val WINDOW = 120
    private const val WINDOW_MS = 3000.0
    private const val TEXT_INTERVAL_MS = 250.0
    private const val LOG_INTERVAL_MS = 1000.0

    /**
     * Sections named on the second line, in the order they are shown. A SUBSET of
     * `ttp_display_profile_names()`, picked because the rest are consistently
     * under a tenth of a millisecond here and a row nobody reads costs the same
     * screen space as one they do. `total` is the first line's `cpu`. The spike
     * lines ([logSpikes]) are NOT limited to this list — a phase that is nothing
     * at the median is exactly what they exist to catch.
     */
    private val SHOWN = listOf("cars", "world", "skids", "decalUp", "build",
        "cellRender", "present", "endFrame")

    /** The backend's own GPU milliseconds, over the same window. See `ttp_display_gpu_ms`. */
    private val gpu = ArrayList<Double>(WINDOW)

    var visible by mutableStateOf(false)
        private set
    var lines by mutableStateOf(listOf<String>())
        private set
    var tint by mutableStateOf(Color.Green)
        private set

    /** Stale history is worse than none: a window straddling the toggle describes neither state. */
    fun show() { visible = true; reset() }
    fun hide() { visible = false }
    fun toggle() { if (visible) hide() else show() }

    private fun reset() {
        stamps.clear(); intervals.clear(); sections.clear(); gpu.clear()
        lastText = 0.0; lastLog = 0.0
        ticks = 0; skipped = 0
    }

    /** Callbacks and, of those, the ones Filament declined to draw. See [record]. */
    private var ticks = 0
    private var skipped = 0

    /** Sample timestamps, parallel to [intervals] — the time bound reads these. */
    private val stamps = ArrayList<Double>(WINDOW)
    private val intervals = ArrayList<Double>(WINDOW)
    /** Per shown section, the trailing window of per-frame milliseconds. */
    private val sections = HashMap<String, ArrayList<Double>>()
    private var lastText = 0.0
    private var lastLog = 0.0

    /** Resolved once: the section names are fixed for the life of the process. */
    private var names: List<String>? = null

    /**
     * One Choreographer callback. `presented` is whether it actually reached the
     * screen — see the callback in [DisplayHost] for why the two are not the same
     * thing here, and why counting callbacks reads 60 on a box showing 15.
     */
    fun record(nowMs: Double, intervalMs: Double, presented: Boolean,
               cells: Int, width: Int, height: Int, track: String) {
        if (!visible) return
        ticks++
        if (!presented) { skipped++; return }
        if (intervalMs <= 0) return          // the first present has no interval
        // EVERY SERIES GETS EXACTLY ONE SAMPLE PER PRESENTED FRAME, so they stay
        // parallel to `stamps` and one trim is correct for all of them. A missing
        // value is recorded as 0 and filtered where it is read, never skipped —
        // skipping would slide one series against the others.
        stamps.add(nowMs)
        intervals.add(intervalMs)
        gpu.add(Ttp.ttp_display_gpu_ms())    // 0 = the query has not come back yet
        readProfile()
        trim(nowMs)
        if (nowMs - lastText < TEXT_INTERVAL_MS) return
        lastText = nowMs
        paint(cells, width, height, track)
        if (nowMs - lastLog >= LOG_INTERVAL_MS) {
            lastLog = nowMs
            // The ONLY channel a scripted sweep has. A TV has no console, and a
            // screenshot of this overlay cannot be diffed against another run.
            for (l in lines) Log.i("TtpPerf", l)
            logSpikes()
        }
    }

    /**
     * The renderer-CPU spike table, LOG-ONLY and at the log's own cadence — the
     * overlay keeps its median split, because a max painted at 4 Hz just
     * flickers. Two lines per log tick:
     *
     *  - `spike name:ms ...` — the full per-phase split of the window's WORST
     *    frame, worst by total+build: the same span the `ttp:render` atrace
     *    marker times, since buildFrame runs before render() and is outside
     *    `total`. This is the line that answers "which phase held the 8-20 ms
     *    frame", because the phases on it are from ONE frame and sum honestly.
     *  - `phasemax name:ms ...` — each phase's own max over the window, for the
     *    second-worst culprit and for spikes that never top a frame.
     *
     * `name:ms` with a COLON is the vocabulary `scripts/androidtv-live.mjs`
     * parses back out of the log — its per-phase spike attribution is keyed on
     * exactly this spelling.
     */
    private fun logSpikes() {
        val n = names ?: return
        val tot = sections["total"] ?: return
        if (tot.isEmpty()) return
        val build = sections["build"]
        var wi = 0
        var wv = -1.0
        for (i in tot.indices) {
            val v = tot[i] + (build?.getOrNull(i) ?: 0.0)
            if (v > wv) { wv = v; wi = i }
        }
        val cols = n.filter { !sections[it].isNullOrEmpty() }
        Log.i("TtpPerf", "spike " + cols.joinToString(" ") {
            "$it:${fmt(sections[it]?.getOrNull(wi) ?: 0.0)}" })
        Log.i("TtpPerf", "phasemax " + cols.joinToString(" ") {
            "$it:${fmt(sections[it]?.maxOrNull() ?: 0.0)}" })
    }

    /**
     * Drop what is older than the window, by count AND by age. Every series is cut
     * to the same length so a percentile over one is over the same frames as a
     * percentile over another.
     */
    private fun trim(nowMs: Double) {
        var drop = maxOf(0, stamps.size - WINDOW)
        while (drop < stamps.size && nowMs - stamps[drop] > WINDOW_MS) drop++
        if (drop == 0) return
        stamps.subList(0, drop).clear()
        intervals.subList(0, drop).clear()
        gpu.subList(0, drop).clear()
        for (v in sections.values) v.subList(0, minOf(drop, v.size)).clear()
    }

    private fun readProfile() {
        val buf = Ttp.ttp_display_profile()
        if (buf == null) {
            for (v in sections.values) v.add(0.0)   // keep the series parallel
            return
        }
        buf.order(ByteOrder.nativeOrder())
        val n = names ?: TtpJson.strOrEmpty(Ttp.ttp_display_profile_names())
            .split(",").also { names = it }
        for (i in n.indices) {
            if ((i + 1) * 8 > buf.capacity()) break
            // EVERY section, not just SHOWN: the spike table reads the whole
            // split of the window's worst frame, and the phase it needs is by
            // definition one the median display had no reason to show.
            sections.getOrPut(n[i]) { ArrayList(WINDOW) }.add(buf.getDouble(i * 8))
        }
    }

    /**
     * Budgets missed by a frame that took `interval`. Rounded rather than floored,
     * because presents land on vsyncs: a 25 ms interval is a frame that slipped
     * one budget, not 1.5 of them.
     */
    private fun missed(interval: Double): Int =
        if (interval > 0) maxOf(0, Math.round(interval / budgetMs).toInt() - 1) else 0

    private fun paint(cells: Int, width: Int, height: Int, track: String) {
        val recent = intervals.takeLast(60)
        val meanMs = if (recent.isEmpty()) 0.0 else recent.average()
        val fps = if (meanMs > 0) (1000.0 / meanMs) else 0.0
        val drops = recent.sumOf { missed(it) }
        val skipPct = if (ticks > 0) skipped * 100 / ticks else 0
        ticks = 0; skipped = 0
        val cpu = median(sections["total"]?.filter { it > 0 })
        val sorted = intervals.sorted()
        val p95 = if (sorted.isEmpty()) 0.0 else sorted[minOf(sorted.size - 1, (sorted.size * 0.95).toInt())]

        // The surface and the cadence on one line, the cost on the next, the split
        // under both. `cells` is here for the reason it is in the siblings: GPU
        // cost scales with cells and pixels together, so a logged number without
        // both is not comparable to any other logged number.
        val split = SHOWN.mapNotNull { s ->
            median(sections[s]?.filter { it > 0 })?.let { "$s ${fmt(it)}" } }
        lines = listOf(
            "${width}x$height · ${cells}c · ${"%.0f".format(Locale.ROOT, fps)} fps · " +
                "$drops drop${if (drops == 1) "" else "s"}${if (track.isEmpty()) "" else " · $track"}",
            "gpu ${share(median(gpu.filter { it > 0 }))} · cpu ${share(cpu)} · " +
                "present ${fmt(p95)}ms p95 · skip $skipPct%",
        ) + split.chunked(3).map { it.joinToString("  ") }

        // The web's thresholds, kept so the three readouts mean the same thing. With
        // no GPU timer the overshoot term is the interval's p95 past one budget.
        // DIAGNOSTIC colours: the sticker palette's veto on amber does not reach a
        // debug overlay, and matching the siblings is worth more than matching theme.
        val over = p95 / budgetMs - 1
        tint = when {
            drops > 2 || over > 1 || (fps > 0 && fps < 48) -> Color(0xFFFF6B6B)
            drops > 0 || over > 0.7 || (fps > 0 && fps < 57) -> Color(0xFFFFD166)
            else -> Color(0xFF7DFC8A)
        }
    }

    private fun fmt(ms: Double) = String.format(Locale.ROOT, "%.1f", ms)

    /**
     * A cost as milliseconds AND share of budget used, low is good — the same
     * sense as the two sibling readouts. The two costs do NOT sum: the CPU builds
     * frame N's commands while the GPU is still drawing N-1.
     */
    private fun share(ms: Double?) =
        ms?.let { "${fmt(it)}ms ${(it / budgetMs * 100).toInt()}%" } ?: "n/a"

    private fun median(xs: List<Double>?): Double? {
        if (xs.isNullOrEmpty()) return null
        return xs.sorted()[xs.size / 2]
    }
}

/**
 * Drop this over everything. It renders nothing at all while the monitor is
 * hidden, and it is never focusable — a focusable debug panel would steal remote
 * presses from the pause overlay and the results button.
 */
@Composable
fun PerfOverlay() {
    if (!PerfMonitor.visible) return
    Column(
        Modifier
            .padding(top = 24.dp, end = 24.dp)
            .background(Color(0xCC000000), RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 9.dp)
    ) {
        for (line in PerfMonitor.lines) {
            BasicText(
                line,
                style = TextStyle(
                    color = PerfMonitor.tint,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = FontFamily.Monospace,
                ),
            )
        }
    }
}
