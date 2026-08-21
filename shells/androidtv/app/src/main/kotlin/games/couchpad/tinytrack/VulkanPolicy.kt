package games.couchpad.tinytrack

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Which Filament backend this launch builds — decided ONCE, at surface create,
 * because an engine cannot switch backends later.
 *
 * VULKAN IS THE DEFAULT on this shell: measured on the reference box it takes
 * the 4-player GPU median from ~27 ms to ~17 (shells/androidtv/CLAUDE.md,
 * "Vulkan"). GL remains one decision away because the Android TV population's
 * Vulkan drivers are not one driver, and the failure mode already observed is
 * the worst kind: a Filament panic on this platform is a silent 100%-CPU hang
 * under the boot cover, not a crash a user or a crash-loop detector can see.
 *
 * Three gates, in order:
 *
 * 1. `debug.ttp.vk` — the adb override: 1 forces Vulkan, -1 forces GL.
 *    Bench arms pin GL through this so their readings stay comparable to the
 *    GL-era ledgers (perf-race passes -1 unless `--vk 1`).
 * 2. The SPIR-V blob set must be in the APK. build-runtime-android.sh skips
 *    compiling it when the host has no matc, and a Vulkan engine handed the GL
 *    blobs fails at material-load — so an APK without `materials-vk/` runs GL,
 *    with a log line rather than a boot failure.
 * 3. The boot canary. [markAttempt] counts a Vulkan boot that has not yet
 *    presented a frame; [markGood] (the first presented frame on a Vulkan
 *    engine) resets it. Two in a row read as "this driver cannot boot the
 *    game" and every later launch runs GL — a fresh install resets the
 *    verdict. DisplayHost also retries the CREATE inline on GL when the
 *    Vulkan engine refuses outright, so a refusing driver still shows a
 *    picture that launch; the refusal keeps its count, so two of those
 *    converge on GL the same way a hang does.
 */
internal object VulkanPolicy {

    private const val TAG = "TtpVulkanPolicy"

    /** Consecutive Vulkan boots that never reached a presented frame. */
    private const val CANARY = "vulkan-canary"
    private const val GIVE_UP_AFTER = 2

    // The blob-set probe answers the same for the life of the APK; the canary
    // file is this process's own writes after boot. Neither needs re-reading.
    private var decided: Boolean? = null

    fun useVulkan(context: Context): Boolean {
        decided?.let { return it }
        val choice = decide(context)
        decided = choice
        return choice
    }

    private fun decide(context: Context): Boolean {
        when (PerfDebug.getprop("debug.ttp.vk")) {
            "1" -> return true
            "-1" -> {
                Log.i(TAG, "GL (debug.ttp.vk -1)")
                return false
            }
        }
        // Probe ONE blob; stage-assets.sh copies the set whole or not at all.
        val staged = try {
            context.assets.open("materials-vk/vcolor.filamat").use { }
            true
        } catch (_: Exception) {
            false
        }
        if (!staged) {
            Log.w(TAG, "GL (no materials-vk/ in this APK — see build-runtime-android.sh)")
            return false
        }
        val failures = canaryFile(context).takeIf { it.exists() }
            ?.readText()?.trim()?.toIntOrNull() ?: 0
        if (failures >= GIVE_UP_AFTER) {
            Log.w(TAG, "GL ($failures Vulkan boots never presented — giving up until reinstall)")
            return false
        }
        return true
    }

    /** A Vulkan boot is starting; presume it dead until [markGood]. */
    fun markAttempt(context: Context) {
        val f = canaryFile(context)
        val failures = f.takeIf { it.exists() }?.readText()?.trim()?.toIntOrNull() ?: 0
        f.writeText("${failures + 1}")
    }

    /** The first presented frame — the boot survived; the slate is clean. */
    fun markGood(context: Context) {
        canaryFile(context).delete()
    }

    private fun canaryFile(context: Context) = File(context.filesDir, CANARY)
}
