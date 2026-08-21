package games.couchpad.tinytrack

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Bytes kept between runs, in a directory, under names the ENGINE chooses.
 *
 * This is the Android half of `ttp_blob_plan_json` and it is deliberately almost
 * nothing: list, read, write, delete. What a blob is called, when it stops being
 * valid and which ones to evict are decided in `libttp-runtime/ttp/blobstore.h`,
 * where they are stated once for every shell and pinned by the `abi` ctest —
 * because the answers are not equally visible when wrong. A bad eviction wastes
 * disk. A bad INVALIDATION serves a stale blob forever, across restarts, with
 * nothing on screen to say so.
 *
 * **[generation] is this shell's one real contribution**, and it is the install
 * time rather than the versionName. A `-dirty` build keeps one version string
 * across many edits, which is exactly the development loop where a stale blob is
 * most likely and hardest to spot; the install time moves whether the version
 * string did or not. The engine folds it into the NAME, so a new binary cannot
 * name the old one's file at all — and the old ones come back in `drop` on the
 * first plan that sees them.
 *
 * NOTHING HERE IS LOAD-BEARING. A miss, a short read, a corrupt blob, a full
 * disk and a failed delete all mean the same thing: compute it again. That is
 * what a cache is, and it is why every road out of this file is a null or a
 * false rather than an exception.
 */
class BlobStore(context: Context, private val store: String) {

    private companion object { const val TAG = "BlobStore" }

    private val dir: File? = try {
        File(context.filesDir, store).apply { mkdirs() }
    } catch (e: Exception) {
        Log.w(TAG, "no $store directory; nothing will be cached", e)
        null
    }

    private val generation: String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
    } catch (e: Exception) {
        // No identity is not "any identity": an empty generation would still
        // name a blob, and every build would then share it. Answer something
        // this run alone can match, so the cache simply never hits.
        Log.w(TAG, "no install stamp; caching for this run only", e)
        "unknown-" + System.nanoTime()
    }

    /**
     * The name [key] lives under, having first performed the plan's deletions.
     *
     * Null when there is nowhere to put anything. Ask once per lookup: the plan
     * answers the name AND the eviction together, so a caller cannot perform one
     * and forget the other.
     */
    fun resolve(key: String): String? {
        val d = dir ?: return null
        val entries = JSONArray()
        d.listFiles()?.forEach {
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
        val req = JSONObject()
            .put("store", store)
            .put("generation", generation)
            .put("key", key)
            .put("entries", entries)
        val plan = TtpJson.obj(Ttp.ttp_blob_plan_json(TtpJson.arg(req.toString())))
        val drop = plan.optJSONArray("drop") ?: JSONArray()
        for (i in 0 until drop.length()) {
            val name = drop.optString(i)
            if (name.isNotEmpty()) runCatching { File(d, name).delete() }
        }
        // optStr, not optString: `name` is a key the ABI spells JSON null
        // elsewhere, and org.json's optString would hand back the STRING "null"
        // — a blob cheerfully written to a file called "null"
        // (tests/androidtv-nullable-json.test.js keeps everyone honest about it).
        return TtpJson.optStr(plan, "name")?.ifEmpty { null }
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

    /** Whether a blob is already held, without reading it. */
    fun has(name: String): Boolean = File(dir ?: return false, name).isFile
}
