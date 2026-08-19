package com.couchgames.tinytrackparty

import android.util.Log

/**
 * Five knobs, driven from `adb setprop`, for measuring this box.
 *
 * ```
 * adb shell setprop debug.ttp.scale 1.0      # pin the render scale (0 = adaptive)
 * adb shell setprop debug.ttp.features 0x1FFC # TTP_FEAT_* mask (see ttp_display.h)
 * adb shell setprop debug.ttp.aa 1           # put the antialias pass back on
 * adb shell setprop debug.ttp.hz 30          # present every other vsync (0/60 = every)
 * adb shell setprop debug.ttp.spectate 7     # camera follows the car that STARTED
 *                                            # in place N (0 = off; next race restores)
 * ```
 *
 * WHY SPECTATE EXISTS: the measurement harness's headless phone cannot steer,
 * so its human car scrapes a wall while the AI pack drives away — every frame
 * it measures is an EMPTYING road, and the fit built on those frames
 * under-read a real player's view by most of a millisecond per megapixel. A
 * real player starts LAST with seven cars, their shadows, items and auras in
 * frame. Following the car that started in place N measures that load with no
 * steering needed — 7, the last AI, is the realistic arm, since the harness's
 * own car (humans start last, place 8) is the wall-scraper itself. It follows
 * the CAR, not the place — a camera that hopped on every overtake would
 * measure cuts.
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
    private var spectateId: EngineId? = null
    private var spectateRoster: List<EngineId> = emptyList()

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
        val hz = getprop("debug.ttp.hz")?.toIntOrNull() ?: 0
        if (hz != lastHz) {
            lastHz = hz
            display.setVsyncInterval(if (hz == 30) 2 else 1)
            Log.i(TAG, "hz -> ${if (hz == 30) 30 else 60}")
        }

        pollSpectate(display)
    }

    /**
     * Follow the car that started in place N. Resolved ONCE per scene (the
     * roster list identity is the scene marker): at the first poll of a race
     * the HUD's places are the grid order, so place N names the Nth grid slot,
     * and the id then sticks for the scene's life. Re-asserted every poll
     * while active — the coordinator re-cells on its own events (reroster,
     * rekey) and would silently take the camera back. Clearing the knob leaves
     * the cells alone; the next race's own setCells restores the human view.
     */
    private fun pollSpectate(display: DisplayHost) {
        val place = getprop("debug.ttp.spectate")?.toIntOrNull() ?: 0
        if (place <= 0) {
            if (spectateId != null) {
                spectateId = null
                spectateRoster = emptyList()
                Log.i(TAG, "spectate -> off (next race restores the human cells)")
            }
            return
        }
        if (!display.hasScene) return
        // RACE CELLS ONLY. The lobby attract is a real bot race underneath —
        // it has places — but its picture is the OVERVIEW camera (no cells),
        // and hijacking that into a chase cam made the welcome screen look
        // like a race (user-caught). The coordinator only assigns cells for
        // real races, so an empty cell set means: leave the overview alone.
        if (display.cellCount == 0) return
        val roster = display.rosterIds
        if (roster.isEmpty()) return
        if (spectateId == null || roster != spectateRoster) {
            val slot = display.hud().firstOrNull { it.place == place }?.slot ?: return
            val id = display.roster.getOrNull(slot) ?: return
            spectateId = id
            spectateRoster = roster
            Log.i(TAG, "spectate -> place $place, slot $slot")
        }
        spectateId?.let { display.setCells(listOf(it)) }
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
