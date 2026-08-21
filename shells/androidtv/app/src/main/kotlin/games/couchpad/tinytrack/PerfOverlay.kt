package games.couchpad.tinytrack

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
import org.json.JSONObject
import java.nio.ByteOrder
import java.util.Locale

/**
 * The frame-cost readout, and the Android half of `render/PerfHud.js` and
 * `Render/PerfOverlay.swift`.
 *
 * WHAT A SHELL DOES HERE IS GATHER. The ring, the trim, the warm-up filter, the
 * percentiles, the two rates, the drop and skip counts and the health verdict are
 * all `ttp_perf.h`'s — read it and `ttp/perf_stats.h` for what the three clocks
 * mean and why they do not sum. This file reads the platform's own instruments
 * (the Choreographer's cadence, `ttp_display_profile`, `ttp_display_gpu_ms`),
 * hands them over, and draws the one canonical readout that comes back. The three
 * hand-written folds this replaces had already drifted apart while all three
 * carried a comment saying they had not.
 *
 * WHAT THIS ONE ADDS OVER ITS TWO SIBLINGS is the per-section split and the spike
 * table, and the reason is a measurement rather than taste: on the web the total
 * is under a millisecond and the sections below it are quantization noise, while
 * here the frame costs tens of milliseconds and WHICH section holds them is the
 * question. There is no ABI for that — the profile buffer is this renderer's own —
 * so the fold for it stays here.
 *
 * WHAT THIS SEES AND WHAT IT STILL CANNOT. `ttp_display_profile`'s `cpu` is the
 * RENDERER's alone, so the rest of the frame thread used to fall outside every
 * number here; [DisplayHost] now measures its own callback and hands the spans
 * over ([SHELL]), which brings the sim tick and the HUD poll in. COMPOSE IS STILL
 * OUTSIDE ALL OF IT — it runs after the callback returns and is nobody's span —
 * and `atrace` remains the instrument for that half, and for anything sub-frame
 * (shells/androidtv/CLAUDE.md).
 *
 * ON BY DEFAULT (every build but a `Scenarios` run) and toggled with KEYCODE_INFO
 * — which this box's remote does not carry, so in practice it is
 * `adb shell input keyevent 165`. Everything is inert while hidden AND unbenched:
 * [record] returns before it touches the profile ABI.
 *
 * MAIN THREAD ONLY, like everything that touches a `ttp_*`.
 */
object PerfMonitor {

    /**
     * ONE LINE PER SECOND, prefixed with this tag, is the bench's whole wire —
     * `console.log('TtpPerf ' + json)` on the web and `print` on tvOS say the same
     * bytes, so one parser reads all three. A TV has no console, and a screenshot
     * of this overlay cannot be diffed against another run.
     */
    private const val TAG = "TtpPerf"

    /** The overlay's own refresh; the log's cadence is the bench contract's 1 Hz. */
    private const val TEXT_INTERVAL_MS = 250.0
    private const val LOG_INTERVAL_MS = 1000.0

    /**
     * The per-section rings hold at most this many frames, AND at most [WINDOW_MS]
     * of them. The frame cap alone is a trap on a slow box, and it cost a whole
     * ablation sweep: 120 frames at 12 fps is TEN SECONDS of history, so every arm
     * of the sweep read as a blend of itself and the arm before it.
     *
     * THE SHARED FOLD DOES NOT DO THIS. `ttp/perf_stats.h` trims by frame count
     * alone; its own `kRecentMs` bounds the rate and the drop/skip counts and
     * never reaches the percentiles. So the readout's cpu/gpu/frame numbers can
     * go stale on a slow box in exactly the way this ring cannot, and an
     * ablation arm has to be given time to fill the window rather than trusted
     * on its first line.
     */
    private const val WINDOW = 120
    private const val WINDOW_MS = 3000.0

    /**
     * `dpr` rides the readout so a logged number carries the pixels it was paid
     * for. Here the surface IS its own pixels — the adaptive scaler sizes the
     * buffer directly and `width`/`height` are that buffer — so there is no second
     * unit to declare. (The browser's canvas is CSS pixels times its dpr, which is
     * why the field exists at all.)
     */
    private const val DPR = 1.0

    /**
     * Sections named on the second line, in the order they are shown. A SUBSET of
     * `ttp_display_profile_names()`, picked because the rest are consistently
     * under a tenth of a millisecond here and a row nobody reads costs the same
     * screen space as one they do. `total` is the readout's own `cpu`. The spike
     * lines ([logSpikes]) are NOT limited to this list — a phase that is nothing
     * at the median is exactly what they exist to catch.
     */
    private val SHOWN = listOf("cars", "world", "skids", "decalUp", "build",
        "cellRender", "present", "endFrame")

    /**
     * The FRAME THREAD's own sections, measured by [DisplayHost] and folded here
     * beside the renderer's, in the order a callback runs them.
     *
     * The renderer's profile stops at `ttp_display_frame`, so the sim tick, the
     * HUD poll and the knob poll — all on this one thread, all inside the same
     * vsync — were outside every number printed here, and a frame lost in them
     * read as a healthy renderer and a mystery. `other` is the callback's
     * remainder (`callback - sim - slow - build - total`), kept as a real
     * per-frame series rather than a subtraction of three percentiles, which is
     * not a duration.
     *
     * `callback` and `total` are AGGREGATES over the columns beside them, not
     * phases. Anything folding this table has to leave them out of an
     * attribution or the total wins every frame — `perf-race.android.mjs` does,
     * and did not, and the column it exists for read 100% `callback`.
     */
    private val SHELL = listOf("sim", "slow", "other", "callback")

    var visible by mutableStateOf(false)
        private set
    var lines by mutableStateOf(listOf<String>())
        private set
    var tint by mutableStateOf(Color.Green)
        private set

    /** See [bench]. */
    private var benching = false

    fun show() { visible = true; reset() }
    fun hide() { visible = false }
    fun toggle() { if (visible) hide() else show() }

    /**
     * MEASURE WITHOUT DRAWING, for `Scenarios`' bench race.
     *
     * The readout is four lines of Compose `BasicText` re-measured at 4 Hz on the
     * one frame thread, which is main-thread work of the same order as anything a
     * bench is hunting — so a benched run logs and shows nothing. It also retires
     * the trap the old harness carried: the panel is a TOGGLE whose state outlives
     * a force-stop, so a script that pressed KEYCODE_INFO blind was a coin flip on
     * whether it had just turned the numbers OFF.
     */
    fun bench() { benching = true; reset() }

    /**
     * Drop both windows. Stale history is worse than none, so this goes wherever
     * what is being measured changes underneath.
     */
    fun reset() {
        stamps.clear(); sections.clear()
        lastText = 0.0; lastLog = 0.0
        Ttp.ttp_perf_reset()
    }

    /** Sample timestamps, parallel to every [sections] series — the age bound reads these. */
    private val stamps = ArrayList<Double>(WINDOW)
    /** Per section, the trailing window of per-frame milliseconds. */
    private val sections = HashMap<String, ArrayList<Double>>()
    private var lastText = 0.0
    private var lastLog = 0.0

    /** Resolved once: the section names are fixed for the life of the process. */
    private var names: List<String>? = null

    /**
     * One Choreographer callback, drawn or not. `presented` is whether it actually
     * reached the screen — see the callback in [DisplayHost] for why the two are
     * not the same thing here, and why counting callbacks reads 60 on a box
     * showing 15. The fold takes both: the tick rate is `hz`, the presents are
     * `fps`, and the gap between them is how many the television never got.
     *
     * `intervalMs` is the CADENCE — since the previous CALLBACK, on every one of
     * them (`ttp_perf.h`). Not the present-to-present interval the scale rule
     * folds, which is a different question and made this box's numbers
     * incomparable with the other two shells' for a while.
     */
    fun record(nowMs: Double, intervalMs: Double, presented: Boolean,
               cells: Int, width: Int, height: Int, track: String,
               simMs: Double = 0.0, slowMs: Double = 0.0, callbackMs: Double = 0.0) {
        // MEASUREMENTS ONLY (ttp_perf.h). A skip contributes no cost sample at
        // all: the renderer returns before writing its total, so the profile still
        // holds the last DRAWN frame, and <= 0 means ABSENT rather than free.
        //
        // The PROFILE is read only when something will draw or log it: it is a
        // ByteBuffer walk plus an append per phase on the frame thread, and it
        // feeds this object's spike table alone — no reader of the readout's
        // `cpu` term exists while the panel is hidden, and the scale rule does
        // not use one at all. Both `show()` and `bench()` drop the window, so a
        // panel switched on mid-run never displays a stretch missing the term.
        val watching = visible || benching
        val cpuMs = if (presented && watching) readProfile(simMs, slowMs, callbackMs) else -1.0
        val gpuMs = if (presented) Ttp.ttp_display_gpu_ms() else -1.0
        Ttp.ttp_perf_sample(nowMs, intervalMs, if (presented) 1 else 0, cpuMs, gpuMs)
        if (presented && watching) { stamps.add(nowMs); trim(nowMs) }

        // THE WINDOW IS ALWAYS KEPT; ONLY THE READOUT IS ON DEMAND. The sample
        // above is a push into a 120-frame ring — the cost of this object is
        // `readout_json` plus four Compose `BasicText` re-measures on the one
        // frame thread, and both are behind the rate limits below.
        //
        // It used to return here when nothing was watching, and that is what
        // forced the render scale to keep a second window of its own: the rule
        // steers off `ttp_display_scale_poll`, which folds off this monitor, so
        // a box with the overlay hidden would have been deciding its resolution
        // on an empty ring. A benched run still draws nothing (see [bench]).
        val wantText = visible && nowMs - lastText >= TEXT_INTERVAL_MS
        val wantLog = watching && nowMs - lastLog >= LOG_INTERVAL_MS
        if (!wantText && !wantLog) return
        // ONE readout, drawn AND logged, deliberately the same bytes so a
        // screenshot and a logged number cannot disagree.
        val out = Ttp.ttp_perf_readout_json(cells, width, height, DPR,
            TtpJson.arg(track.ifEmpty { null }))
        if (wantText) { lastText = nowMs; paint(TtpJson.obj(out)) }
        if (wantLog) {
            lastLog = nowMs
            Log.i(TAG, TtpJson.strOrEmpty(out))
            logSpikes()
        }
    }

    /**
     * The frame-thread cost table, LOG-ONLY and at the log's own cadence — the
     * overlay keeps its median split, because a max painted at 4 Hz just
     * flickers. FOUR lines per log tick: two about the window's worst frame, two
     * about a typical one.
     *
     *  - `spike name:ms ...` — the full per-phase split of the window's WORST
     *    frame, worst by total+build: the same span the `ttp:render` atrace
     *    marker times, since buildFrame runs before render() and is outside
     *    `total`. This is the line that answers "which phase held the 8-20 ms
     *    frame", because the phases on it are from ONE frame and sum honestly.
     *  - `phasemax name:ms ...` — each phase's own max over the window, for the
     *    second-worst culprit and for spikes that never top a frame.
     *  - `phase50` and `phase95 name:ms ...` — what a TYPICAL frame spends per
     *    phase, which neither line above says and which a map of the frame
     *    cannot be drawn from either.
     *
     * `name:ms` with a COLON is the vocabulary `scripts/perf-race.android.mjs`
     * and `scripts/perf-frame.mjs` parse back out of the log — their per-phase
     * folds are keyed on exactly this spelling, and a JSON readout line is told
     * from these by its leading brace.
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
        val cols = (n + SHELL).filter { !sections[it].isNullOrEmpty() }
        Log.i(TAG, "spike " + cols.joinToString(" ") {
            "$it:${fmt(sections[it]?.getOrNull(wi) ?: 0.0)}" })
        Log.i(TAG, "phasemax " + cols.joinToString(" ") {
            "$it:${fmt(sections[it]?.maxOrNull() ?: 0.0)}" })
        // WHAT A TYPICAL FRAME SPENDS, which the two lines above deliberately do
        // not say: they are the window's WORST frame and each phase's own worst,
        // and a map of where a frame's time goes cannot be drawn from either.
        // Same `name:ms` vocabulary, so one parser reads all four.
        Log.i(TAG, "phase50 " + cols.joinToString(" ") {
            "$it:${fmt(pct(sections[it], 0.5))}" })
        Log.i(TAG, "phase95 " + cols.joinToString(" ") {
            "$it:${fmt(pct(sections[it], 0.95))}" })
    }

    /**
     * One column's percentile over the window, 0 for a series nothing filled.
     *
     * A percentile computed HERE, against this class's own "the percentiles are
     * `ttp_perf.h`'s" — and for the same reason the split above is this file's:
     * the per-section series has no ABI, so there is nothing shared to defer to.
     */
    private fun pct(xs: List<Double>?, q: Double): Double {
        if (xs.isNullOrEmpty()) return 0.0
        val s = xs.sorted()
        return s[minOf(s.size - 1, (s.size * q).toInt())]
    }

    /**
     * Drop what is older than the window, by count AND by age. Every series is cut
     * to the same length so a median over one is over the same frames as a median
     * over another.
     */
    private fun trim(nowMs: Double) {
        var drop = maxOf(0, stamps.size - WINDOW)
        while (drop < stamps.size && nowMs - stamps[drop] > WINDOW_MS) drop++
        if (drop == 0) return
        stamps.subList(0, drop).clear()
        for (v in sections.values) v.subList(0, minOf(drop, v.size)).clear()
    }

    /**
     * The frame's per-section split into [sections], and its `total` back as the
     * cpu millisecond the fold takes. -1 is ABSENT, which is not zero.
     */
    private fun readProfile(simMs: Double, slowMs: Double, callbackMs: Double): Double {
        val buf = Ttp.ttp_display_profile()
        if (buf == null) {
            for (v in sections.values) v.add(0.0)   // keep the series parallel
            return -1.0
        }
        buf.order(ByteOrder.nativeOrder())
        val n = names ?: TtpJson.strOrEmpty(Ttp.ttp_display_profile_names())
            .split(",").also { names = it }
        var total = -1.0
        for (i in n.indices) {
            if ((i + 1) * 8 > buf.capacity()) break
            val ms = buf.getDouble(i * 8)
            if (n[i] == "total") total = ms
            // EVERY section, not just SHOWN: the spike table reads the whole
            // split of the window's worst frame, and the phase it needs is by
            // definition one the median display had no reason to show.
            sections.getOrPut(n[i]) { ArrayList(WINDOW) }.add(ms)
        }
        // The frame thread's own split, appended in the same pass so every series
        // is over the same frames — [trim] cuts them all to one length and a
        // median over one column has to mean the same frames as a median over
        // the next.
        val render = (if (total > 0) total else 0.0) + (sections["build"]?.lastOrNull() ?: 0.0)
        sections.getOrPut("sim") { ArrayList(WINDOW) }.add(simMs)
        sections.getOrPut("slow") { ArrayList(WINDOW) }.add(slowMs)
        sections.getOrPut("other") { ArrayList(WINDOW) }
            .add(maxOf(0.0, callbackMs - simMs - slowMs - render))
        sections.getOrPut("callback") { ArrayList(WINDOW) }.add(callbackMs)
        return total
    }

    /** The surface and the cadence on one line, the cost on the next, the split under both. */
    private fun paint(r: JSONObject) {
        val budget = r.optDouble("budgetMs")
        val drops = r.optInt("drops")
        // `cells` and the buffer size are on the first line for the reason they are
        // in the readout at all: GPU cost scales with cells and pixels together, so
        // a number carrying neither is not comparable to any other number.
        val head = "${r.optInt("width")}x${r.optInt("height")} · ${r.optInt("cells")}c"
        // An unknown rate is not a bad one — the fold says when it has enough
        // presents to mean anything, and until then this shows the tick rate alone.
        val cadence = when {
            r.optBoolean("warming") -> "warming"
            !r.optBoolean("fpsReady") -> "${r.optInt("hz")} hz"
            else -> "${r.optInt("fps")} fps · ${r.optInt("hz")} hz · " +
                "$drops drop${if (drops == 1) "" else "s"}"
        }
        // optStr: `track` is a nullable engine key, and org.json reads an explicit
        // JSON null back as the STRING "null".
        val track = TtpJson.optStr(r, "track")?.let { " · $it" } ?: ""
        val split = SHOWN.mapNotNull { s ->
            median(sections[s]?.filter { it > 0 })?.let { "$s ${fmt(it)}" } }
        lines = listOf(
            "$head · $cadence$track",
            "gpu ${share(stat(r, "gpu", "p50"), budget)}" +
                " · cpu ${share(stat(r, "cpu", "p50"), budget)}" +
                // `frame` is the TICK cadence, not present-to-present — the
                // shared readout's own definition (ttp_perf.h). Labelled
                // "present" it said something the fold does not, on the one
                // number a developer reads first when diagnosing a starved
                // panel; `skip` beside it is what counts late PRESENTS.
                " · tick ${share(stat(r, "frame", "p95"), budget)} p95" +
                " · skip ${r.optInt("skips")}",
        ) + split.chunked(3).map { it.joinToString("  ") }
        tint = when (r.optString("verdict")) {
            "bad" -> Color(0xFFFF6B6B)
            "warn" -> Color(0xFFFFD166)
            else -> Color(0xFF7DFC8A)
        }
    }

    /** One `{max,n,p05,p50,p95}` field, or null for a series this platform has none of. */
    private fun stat(r: JSONObject, series: String, field: String): Double? =
        r.optJSONObject(series)?.optDouble(field)

    private fun fmt(ms: Double) = String.format(Locale.ROOT, "%.1f", ms)

    /**
     * A cost as milliseconds AND share of budget used, low is good — the same
     * sense as the two sibling readouts. The two costs do NOT sum: the CPU builds
     * frame N's commands while the GPU is still drawing N-1.
     */
    private fun share(ms: Double?, budgetMs: Double) =
        ms?.let { "${fmt(it)}ms ${if (budgetMs > 0) (it / budgetMs * 100).toInt() else 0}%" } ?: "n/a"

    private fun median(xs: List<Double>?): Double? {
        if (xs.isNullOrEmpty()) return null
        return xs.sorted()[xs.size / 2]
    }
}

/**
 * Drop this over everything. It renders nothing at all while the monitor is
 * hidden, and it is never focusable — a focusable debug panel would steal remote
 * presses from the pause overlay and the results button.
 *
 * DIAGNOSTIC colours, not chrome: the sticker palette's veto on amber does not
 * reach a debug overlay, and the three readouts agreeing on what amber MEANS
 * (`ttp/perf_stats.h`'s verdict) is worth more than matching the theme.
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
