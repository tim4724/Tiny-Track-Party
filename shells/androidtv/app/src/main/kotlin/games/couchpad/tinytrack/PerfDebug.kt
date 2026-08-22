package games.couchpad.tinytrack

import android.util.Log

/**
 * The knobs, driven from `adb setprop`, for measuring this box.
 *
 * ```
 * adb shell setprop debug.ttp.perf 1         # put the frame-cost readout UP (0/unset = off)
 * adb shell setprop debug.ttp.scale 1.0      # pin the render scale (0 = adaptive)
 * adb shell setprop debug.ttp.features 0x1FFC # TTP_FEAT_* mask (see ttp_display.h)
 * adb shell setprop debug.ttp.aa 1           # put the antialias pass back on
 * adb shell setprop debug.ttp.hz 30          # PIN every-other-vsync (0 = hand it back to the rule)
 * adb shell setprop debug.ttp.mv -1          # multiview OFF (-1); 1 = 4-cell splits
 *                                            # (the default), 2 = ANY split (measured
 *                                            # regression at 2P/3P — experiments only)
 * adb shell setprop debug.ttp.vk 1           # backend override: 1 Vulkan, -1 GL,
 *                                            # unset = VulkanPolicy (Vulkan when it can)
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

    /** 0, not -1: the panel really is down at launch, so an unset property is a no-op. */
    private var lastPerf = 0
    private var lastMask = -1
    private var lastScale = -1.0
    private var lastAa = 0
    private var lastHz = -1
    /** 1, not 0: mode 0 is what -1 ("off") maps to; the engine's default is 1. */
    private var lastMv = 1

    /** Read the knobs and apply whatever moved. */
    fun poll(display: DisplayHost) {
        // THE READOUT ITSELF, which is off until this says otherwise (MainActivity
        // says why). A property rather than only KEYCODE_INFO for the reason every
        // knob here is one: it survives a force-stop, so a sweep that relaunches
        // the app between arms does not have to press anything, and it cannot land
        // on the wrong side of a toggle it could not read back.
        //
        // KEYCODE_INFO still works and is not fought over: this acts on a CHANGE,
        // so a panel opened by the key stays open until the property itself moves.
        val perf = getprop("debug.ttp.perf")?.toIntOrNull() ?: 0
        if (perf != lastPerf) {
            lastPerf = perf
            if (perf != 0) PerfMonitor.show() else PerfMonitor.hide()
            Log.i(TAG, "perf readout -> ${if (perf != 0) "on" else "off"}")
        }

        val mask = getprop("debug.ttp.features")?.let { parseInt(it) } ?: 0
        if (mask != lastMask) {
            lastMask = mask
            // 0 means "not set" rather than "hide everything": a cleared property
            // has to restore the picture, or a sweep that dies mid-run leaves the
            // box showing an empty world with no way back but a reinstall.
            Ttp.ttp_display_debug_features(if (mask == 0) TTP_FEAT_ALL else mask)
            // WHAT IS BEING MEASURED JUST CHANGED, so the window behind every
            // number goes with it (`ttp_perf.h`). Without this an arm's first
            // seconds are a blend of itself and the arm before it, and on a slow
            // box that ring is three whole seconds deep — the trap
            // [PerfMonitor.WINDOW_MS] exists for, one level up.
            PerfMonitor.reset()
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

        // Multiview split-screen: a live path switch (the engine is stereo-
        // configured either way — see ttp_display_android.cc), so an A/B
        // interleaves on one launch. Same "0 restores the default" contract as
        // the feature mask — the engine's default is mode 1 (4-cell splits),
        // so OFF has to be spelled -1 or a cleared property could not restore.
        // What changed is what is measured, so the window resets too.
        val mvRaw = getprop("debug.ttp.mv")?.toIntOrNull() ?: 0
        val mv = if (mvRaw == 0) 1 else if (mvRaw < 0) 0 else mvRaw
        if (mv != lastMv) {
            lastMv = mv
            Ttp.ttp_display_multiview(mv)
            PerfMonitor.reset()
            Log.i(TAG, "multiview -> $mv")
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
     *
     * Internal because [VulkanPolicy] reads its override (`debug.ttp.vk` — not a
     * knob this poll can act on: a backend exists only at engine creation).
     */
    internal fun getprop(key: String): String? = try {
        val cls = Class.forName("android.os.SystemProperties")
        (cls.getMethod("get", String::class.java).invoke(null, key) as? String)
            ?.takeIf { it.isNotEmpty() }
    } catch (_: Throwable) {
        null
    }
}
