package games.couchpad.tinytrack

import android.util.Log

/**
 * Four knobs, driven from `adb setprop`, for measuring this box.
 *
 * ```
 * adb shell setprop debug.ttp.scale 1.0      # pin the render scale (0 = adaptive)
 * adb shell setprop debug.ttp.features 0x1FFC # TTP_FEAT_* mask (see ttp_display.h)
 * adb shell setprop debug.ttp.aa 1           # put the antialias pass back on
 * adb shell setprop debug.ttp.hz 30          # PIN every-other-vsync (0 = hand it back to the rule)
 * ```
 *
 * WHY PROPERTIES AND NOT A KEY. An ablation sweep is a dozen arms, each needing a
 * mask AND a pinned resolution, and the answer is only worth anything if every arm
 * ran at the same size — the adaptive scaler moving under the sweep is exactly the
 * confound that makes two arms incomparable. A TV remote cannot express that; a
 * shell script over adb can, and it is the same script that reads the numbers back
 * out of [PerfMonitor]'s log.
 *
 * Live in release ON PURPOSE — a debug gate made every knob silently inert and
 * every sweep measured the wrong build (shells/androidtv/CLAUDE.md, MEASURE THE
 * BUILD THAT SHIPS). Cheap and bounded: `debug.`-prefixed props are adb-only.
 *
 * Polled at the HUD's ~6 Hz tick rather than per frame: a property read is a
 * binder round trip.
 */
object PerfDebug {

    private const val TAG = "TtpPerfDebug"

    /** `ttp_display.h`'s TTP_FEAT_ALL. One source; `tests/feature-bits.test.js` pins this mirror. */
    private const val TTP_FEAT_ALL = 0x1FFC

    private var lastMask = -1
    private var lastScale = -1.0
    private var lastAa = 0
    private var lastHz = -1

    /** Read the knobs and apply whatever moved. */
    fun poll(display: DisplayHost) {
        val mask = getprop("debug.ttp.features")?.let { parseInt(it) } ?: 0
        if (mask != lastMask) {
            lastMask = mask
            // 0 means "not set" rather than "hide everything": a cleared property
            // has to restore the picture, or a sweep that dies mid-run leaves the
            // box showing an empty world with no way back but a reinstall.
            Ttp.ttp_display_debug_features(if (mask == 0) TTP_FEAT_ALL else mask)
            Log.i(TAG, "features -> 0x${Integer.toHexString(if (mask == 0) TTP_FEAT_ALL else mask)}")
        }

        // The antialias pass costs a share of the BUFFER, and the buffer is
        // adaptive — so what it is worth depends entirely on where the scaler
        // has settled, and that is a question only a measurement answers.
        val aa = getprop("debug.ttp.aa")?.toIntOrNull() ?: 0
        if (aa != lastAa) {
            lastAa = aa
            Ttp.ttp_display_antialias(aa)
            Log.i(TAG, "antialias -> $aa")
        }

        val scale = getprop("debug.ttp.scale")?.toDoubleOrNull() ?: 0.0
        if (scale != lastScale) {
            lastScale = scale
            display.pinScale(scale)
            Log.i(TAG, "scale pin -> $scale")
        }

        // 30 presents every OTHER vsync — a locked, evenly-paced 30 fps whose
        // doubled budget the adaptive scaler spends on resolution (~1600x900+
        // where 60 Hz affords ~900 lines). The sim still ticks at 60, so only
        // the picture's latency doubles; whether that trade should ever be
        // AUTOMATIC is a product call parked until a real-phone tilt drive
        // says what the added latency feels like. 0 or unset = every vsync.
        //
        // The readout FOLLOWS this knob: the divisor is declared to it
        // (`ttp_perf_pacing`), so a pinned 30 on an idle box reads GOOD against a
        // doubled budget rather than scoring its own pacing as damage. It once
        // did the latter, and a permanently red panel is one nobody reads.
        val hz = getprop("debug.ttp.hz")?.toIntOrNull() ?: 0
        if (hz != lastHz) {
            lastHz = hz
            display.pinVsyncInterval(if (hz == 30) 2 else 0)
            Log.i(TAG, "hz -> ${if (hz == 30) "pinned 30" else "adaptive"}")
        }
    }

    private fun parseInt(s: String): Int? =
        if (s.startsWith("0x")) s.drop(2).toIntOrNull(16) else s.toIntOrNull()

    /**
     * `SystemProperties.get` by reflection. It is hidden API, and it is on the
     * allowed list — this box logs the access and serves it. There is no public
     * equivalent, and the alternative (`Runtime.exec("getprop")`) forks a process.
     */
    private fun getprop(key: String): String? = try {
        val cls = Class.forName("android.os.SystemProperties")
        (cls.getMethod("get", String::class.java).invoke(null, key) as? String)
            ?.takeIf { it.isNotEmpty() }
    } catch (_: Throwable) {
        null
    }
}
