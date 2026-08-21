package games.couchpad.tinytrack

import android.content.Context
import android.util.Log

/**
 * The sun bake, kept between runs.
 *
 * A scene build blocks this shell's one thread, and ~520 ms of it is the sun
 * bake: a depth render over every caster, an 81-tap ESM blur and the ground's
 * visibility decode, each ending in a `flushAndWait`. The renderer already keeps
 * ONE bake in memory, which is what makes a rebuild for a new field (a phone
 * joining, a launch dressing the grid the lobby was previewing) nearly free.
 * This is the tier below that: a track the host previewed in an earlier session
 * costs a file read and two texture uploads instead of the blur.
 *
 * **The bake is resolution-independent**, which is what makes any of this legal:
 * its three sizes are compile-time constants and no viewport, window or
 * render-scale value reaches it (`ttp_display.h`). A blob written at 540p is
 * correct at 720p and stays correct while the adaptive scaler moves.
 *
 * WHAT IS AND IS NOT HERE. This file knows two things nothing else does: that a
 * bake is worth keeping, and that `ttp_display_bake_key` is what it is keyed by.
 * Everything else about caching — the filename, the invalidation, the eviction —
 * belongs to [BlobStore] over `ttp_blob_plan_json`, so the next shell inherits
 * those answers instead of re-deriving them. That split is not tidiness: a wrong
 * invalidation rule serves stale shadows forever, across restarts, and it should
 * not be possible for two shells to disagree about it.
 */
class BakeCache(context: Context) {

    private companion object { const val TAG = "BakeCache" }

    private val blobs = BlobStore(context, "bake")

    /**
     * Which key the ENGINE is holding, as far as this side knows.
     *
     * [forget] exists because the mirror can go stale in exactly one way: a
     * destroyed surface takes the renderer and its textures with it
     * (shells/androidtv/CLAUDE.md), so the engine comes back holding nothing
     * while this string still names a track.
     */
    private var resident: String? = null

    /** The engine dropped everything; so does the mirror. */
    fun forget() { resident = null }

    /**
     * Hand the engine whatever we hold for the scene it is ABOUT to build, and
     * report whether it took it — the caller uses that to decide whether the
     * build it then runs is worth writing back.
     *
     * Called after the biome latch and before the build, which is the only
     * window `ttp_display_bake_key` is defined over.
     */
    fun prime(trackId: String): Boolean {
        val key = TtpJson.strOrEmpty(Ttp.ttp_display_bake_key(TtpJson.arg(trackId)))
        // ALREADY IN THE ENGINE. The import would early-out on its own key check,
        // but only after this side had read ~2.7 MB off disk to tell it something
        // it knew — and the commonest build of all (the same track, a new field)
        // takes exactly this path.
        if (key.isNotEmpty() && key == resident) return true
        val name = blobs.resolve(key) ?: return false
        val bytes = blobs.read(name) ?: return false
        val took = Ttp.ttp_display_bake_import(bytes) != 0
        if (took) {
            resident = key
            Log.i(TAG, "bake restored from disk for $key")
        } else {
            // The engine refused it: a version it does not know, or bytes that
            // do not describe what they claim. Nothing to salvage.
            Log.w(TAG, "bake for $key refused; it will be rebaked")
        }
        return took
    }

    /**
     * Keep what the build just baked. A no-op when [prime] already served this
     * scene — the bytes would be the ones we just read.
     *
     * The export costs a readback of both maps, so it is spent only on the build
     * that actually baked, and only once per track per installed binary.
     */
    fun store(trackId: String) {
        val key = TtpJson.strOrEmpty(Ttp.ttp_display_bake_key(TtpJson.arg(trackId)))
        val name = blobs.resolve(key) ?: return
        if (blobs.has(name)) return
        val blob = Ttp.ttp_display_bake_export() ?: return
        blobs.write(name, blob)
        resident = key
        Log.i(TAG, "bake stored for $key (${blob.size / 1024} KiB)")
    }
}
