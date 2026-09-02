package games.couchpad.tinytrack

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The knobs, driven from `adb setprop`, for measuring this box.
 *
 * ```
 * adb shell setprop debug.ttp.perf 1         # put the frame-cost readout UP (0/unset = off)
 * adb shell setprop debug.ttp.scale 1.0      # pin the render scale (0 = adaptive)
 * adb shell setprop debug.ttp.features 0x1FFC # TTP_FEAT_* mask (see ttp_display.h)
 * adb shell setprop debug.ttp.aa 1           # put the antialias pass back on
 * adb shell setprop debug.ttp.dresskeep 0.5  # keep half the merged dressing COPIES
 * adb shell setprop debug.ttp.dresssheets 0  # the dressing SHEETS out of the scene
 *                                            # (1/unset = the whole scene; the two
 *                                            # halves of TTP_FEAT_DRESSING, which
 *                                            # ttp_display.h explains)
 * adb shell setprop debug.ttp.hz 30          # PIN every-other-vsync (0 = hand it back to the rule)
 * adb shell setprop debug.ttp.shadow '{"rows":128}'   # car-shadow tuning, PARTIAL json (unset = shipped)
 * adb shell setprop debug.ttp.vk 1           # backend override: 1 Vulkan, -1 GL,
 *                                            # unset = VulkanPolicy (Vulkan when it can)
 * adb shell setprop debug.ttp.hud 0          # compose NO race chrome (1/unset = shown):
 *                                            # prices the Compose window's own GPU share
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
    private const val TTP_FEAT_ALL = 0xDFFC

    /** 0, not -1: the panel really is down at launch, so an unset property is a no-op. */
    private var lastPerf = 0
    private var lastMask = -1
    private var lastScale = -1.0
    private var lastAa = 0
    /** Both default to the whole scene, so an unset property is a no-op. */
    private var lastDressKeep = 1.0
    private var lastDressSheets = 1
    private var lastHz = -1

    /** Empty = the shipped tuning, so an unset property is a no-op. */
    private var lastShadow = ""

    /**
     * `debug.ttp.hud 0` composes NO race chrome. An A/B knob for the one GPU
     * consumer no Filament timer can see: the Compose window is a second 1080p
     * surface on the same GPU, and every HUD redraw is a frame HWUI renders
     * between two of ours.
     */
    var hudHidden by mutableStateOf(false)
        private set

    /** Read the knobs and apply whatever moved. */
    fun poll(display: DisplayHost) {
        val hud = getprop("debug.ttp.hud")?.toIntOrNull() ?: 1
        if ((hud == 0) != hudHidden) {
            hudHidden = hud == 0
            Log.i(TAG, "race hud -> ${if (hudHidden) "hidden" else "shown"}")
        }

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

        // Both rebuild or re-state the scene rather than masking anything, so
        // they land live -- and what is being measured has changed, so the
        // window goes with them exactly as the feature mask's does.
        val dressKeep = getprop("debug.ttp.dresskeep")?.toDoubleOrNull() ?: 1.0
        if (dressKeep != lastDressKeep) {
            lastDressKeep = dressKeep
            Ttp.ttp_display_dress_keep(dressKeep.toFloat())
            PerfMonitor.reset()
            Log.i(TAG, "dress keep -> $dressKeep")
        }

        val sheets = getprop("debug.ttp.dresssheets")?.toIntOrNull() ?: 1
        if (sheets != lastDressSheets) {
            lastDressSheets = sheets
            Ttp.ttp_display_dress_sheets(sheets)
            PerfMonitor.reset()
            Log.i(TAG, "dress sheets -> $sheets")
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

        // THE CAR SHADOW'S TUNING, as the JSON `ttp_display_shadow_tuning` takes
        // (a PARTIAL object — anything left out keeps its shipped value). This
        // box is the one the shadow's cost has to be answered on, and the web
        // tuning page cannot answer for it: the channel is ~3 ms of CPU here and
        // essentially free on a desktop GPU, so every arm of that question has
        // to be settable over adb like the rest of this file.
        //
        //   adb shell setprop debug.ttp.shadow '{"texelsPerU":8,"rows":128}'
        //   adb shell setprop debug.ttp.shadow '{"uploadWhole":true}'
        //
        // A property is capped at 91 characters, which is plenty for the two or
        // three keys an arm moves and is why this takes a partial object rather
        // than a whole tuning.
        val shadow = getprop("debug.ttp.shadow") ?: ""
        if (shadow != lastShadow) {
            lastShadow = shadow
            // Clearing the property RESTORES the shipped tuning rather than
            // leaving the last arm latched — same reason the feature mask treats
            // 0 as "not set": a sweep that dies mid-run must not leave the box
            // in an arm nobody can see.
            // The bridge takes UTF-8 bytes, not a String (shells/androidtv/CLAUDE.md).
            Ttp.ttp_display_shadow_tuning(TtpJson.arg(if (shadow.isEmpty()) "{}" else shadow))
            PerfMonitor.reset()
            Log.i(TAG, "shadow -> ${if (shadow.isEmpty()) "shipped" else shadow}")
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
