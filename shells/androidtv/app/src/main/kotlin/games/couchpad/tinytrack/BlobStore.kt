package games.couchpad.tinytrack

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Bytes kept between runs, in a directory, under names the ENGINE chooses.
 *
 * FOUR PRIMITIVES AND NO POLICY. This lists, reads, writes and deletes; it does
 * not know what a blob contains, what it is called, when it stops being valid or
 * which one to throw away. Those are rules rather than platform facts, and they
 * live in `libttp-runtime/ttp/blobstore.h` where they are stated once for every
 * shell and pinned by the `abi` ctest — because the answers are not equally
 * visible when wrong. A bad eviction wastes disk. A bad INVALIDATION serves a
 * stale blob forever, across restarts, with nothing on screen to say so.
 *
 * It knows nothing about WHAT it is storing either — not that a sun bake exists,
 * nor a silhouette layer, nor how many kinds there are. That is the point of the
 * walk in `ttp_display.h`: the engine lists its stores, decides what to read,
 * keep and drop, and hands this a name. There used to be a `BakeCache` beside
 * this file holding that choreography — the window a bake key is defined over,
 * whether the engine already had the bake, whether the build had actually baked
 * — and every line of it was knowledge about the ENGINE living in a shell, with
 * a mirror this side had to invalidate whenever a destroyed surface took the
 * renderer away. It is also why the SECOND blob kind needed no Kotlin at all.
 *
 * **[generation] is this shell's one real contribution**, and it is the install
 * time rather than the versionName. A `-dirty` build keeps one version string
 * across many edits, which is exactly the development loop where a stale blob is
 * most likely and hardest to spot; the install time moves whether the version
 * string did or not. The engine folds it into the NAME, so a new binary cannot
 * name the old one's file at all.
 *
 * NOTHING HERE IS LOAD-BEARING. A miss, a short read, a corrupt blob, a full
 * disk and a failed delete all mean the same thing: compute it again. That is
 * what a cache is, and it is why every road out of this file is a null or a
 * no-op rather than an exception.
 */
class BlobStore(context: Context, private val store: String) {

    private companion object { const val TAG = "BlobStore" }

    private val dir: File? = try {
        File(context.filesDir, store).apply { mkdirs() }
    } catch (e: Exception) {
        Log.w(TAG, "no $store directory; nothing will be cached", e)
        null
    }

    /** What identifies the binary that produced (or would produce) these bytes. */
    val generation: String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
    } catch (e: Exception) {
        // No identity is not "any identity": an empty generation would still
        // name a blob, and every build would then share it. Answer something
        // this run alone can match, so the cache simply never hits.
        Log.w(TAG, "no install stamp; caching for this run only", e)
        "unknown-" + System.nanoTime()
    }

    /**
     * Everything held, as the walk's `entries` argument.
     *
     * `usedMs` is this shell's clock and is never compared against anything but
     * its siblings — an epoch, an uptime and a file mtime all sort the same way.
     */
    fun entriesJson(): String {
        val entries = JSONArray()
        dir?.listFiles()?.forEach {
            if (!it.isFile) return@forEach
            // A `.part` is a write that died between its temp file and its
            // rename, so it is junk rather than a blob: it can never be read
            // back (no plan ever names it) but it WOULD count towards the cap,
            // and evicting a real blob to make room for a corpse is the one way
            // this could cost something. Dropped on sight, like [read] drops a
            // blob it cannot parse.
            if (it.name.endsWith(".part")) { runCatching { it.delete() }; return@forEach }
            entries.put(JSONObject().put("name", it.name).put("usedMs", it.lastModified().toDouble()))
        }
        return entries.toString()
    }

    /** The blob's bytes, or null for a miss. Touches it, so eviction sees it as used. */
    fun read(name: String): ByteArray? {
        val f = File(dir ?: return null, name)
        if (!f.isFile) return null
        return try {
            val bytes = f.readBytes()
            f.setLastModified(System.currentTimeMillis())
            bytes
        } catch (e: Exception) {
            Log.w(TAG, "unreadable blob $name; dropping it", e)
            f.delete()
            null
        }
    }

    /**
     * Store bytes under [name].
     *
     * Through a temporary, because a half-written blob that a crash leaves
     * behind must not be read back as a whole one — the engine would refuse it
     * on its length checks, but only after paying to find out.
     */
    fun write(name: String, bytes: ByteArray) {
        val d = dir ?: return
        try {
            val tmp = File(d, "$name.part")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(File(d, name))) tmp.delete()
        } catch (e: Exception) {
            Log.w(TAG, "could not store blob $name", e)
        }
    }

    /** Throw one away. A delete that fails is not an error; the plan repeats it. */
    fun delete(name: String) {
        val d = dir ?: return
        runCatching { File(d, name).delete() }
    }
}

/**
 * One [BlobStore] per store the ENGINE says it has.
 *
 * The names are asked for rather than typed, which is the whole point: this
 * shell does not know that a "bake" or a "mask" exists, only that the engine
 * keeps some kinds of derived bytes and that each kind wants its own directory.
 * A third kind needs no Kotlin at all.
 */
class BlobStores(context: Context) {

    private val stores: Map<String, BlobStore> =
        TtpJson.strings(Ttp.ttp_display_blob_stores())
            .associateWith { BlobStore(context, it) }

    /** Perform something for each store, with the name the engine calls it. */
    inline fun forEach(action: (BlobStore, String) -> Unit) {
        for ((name, store) in all) action(store, name)
    }

    /** Exposed for [forEach]'s inlining; not otherwise interesting. */
    val all: Map<String, BlobStore> get() = stores
}
