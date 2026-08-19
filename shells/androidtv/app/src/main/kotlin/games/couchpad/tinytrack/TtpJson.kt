package games.couchpad.tinytrack

import org.json.JSONArray
import org.json.JSONObject

/**
 * The marshalling rules `native/runtime/ttp_abi.h` states, in one place.
 *
 * Every one of these is a rule the C side already documents; none is a decision
 * this shell gets to take. They are here so no call site has to remember them,
 * because each has a silent failure mode:
 *
 * - **Int returns are ONE polarity: truth is non-zero.** `ttp_abi.h` says so,
 *   and it says so because they were not always — the display trio used to carry
 *   C exit-status polarity (0 = success) and was flipped 2026-07-31. A shell
 *   ported from a revision that had one is inverting those checks.
 *   The exceptions are named at their own declarations, and there are more than
 *   two, so do not treat this list as the authority: `ttp_display_frame` (1 =
 *   drew, 0 = a legitimate pace skip); the COUNTS `ttp_display_cell_rects`,
 *   `ttp_room_size`, `ttp_room_connected_count`; `ttp_car_finished` (-1 for an
 *   unknown car); and `ttp_process_input` (the mask it consumed, 0 for nothing
 *   applied, -1 for no such car).
 * - **An identity crosses as a JSON SCALAR inside a string.** `3` and `"3"` are
 *   different players. See [EngineId].
 * - **Returned JSON is canonical (sorted keys) except from `ttp_ui.h` and
 *   `ttp_net.h`**, which emit the model's own key order. Nothing here may depend
 *   on either — the wire re-sorts everything anyway.
 *
 * ONE RULE FROM THE OTHER TWO SHELLS IS ALREADY GONE. A returned `const char*`
 * points into per-handle scratch valid only until the next call on that handle,
 * and `TTP.swift` has a `str()` whose whole job is to copy before that happens.
 * Here the generated JNI copies into a fresh `ByteArray` at the call site, so
 * the hazard cannot reach Kotlin at all.
 */
object TtpJson {

    /**
     * UTF-8, always. The bridge never uses jstring — see `ttp_jni.cc`'s header.
     *
     * **An EMPTY answer collapses to null here**, deliberately and lossily: the
     * bridge itself keeps the distinction (a null `const char*` returns a null
     * ByteArray, an empty one a zero-length array), and this throws it away
     * because every caller of this overload spells "no answer" both ways and none
     * distinguishes them. A caller that needs the difference wants [strOrEmpty].
     */
    fun str(b: ByteArray?): String? {
        if (b == null || b.isEmpty()) return null
        return String(b, Charsets.UTF_8)
    }

    /**
     * Same, for the calls whose empty answer is meaningful (an empty array, an
     * empty name).
     */
    fun strOrEmpty(b: ByteArray?): String = if (b == null) "" else String(b, Charsets.UTF_8)

    /**
     * A nullable string out of a DECODED payload — **the only safe way to read one
     * on this platform.**
     *
     * Android's `org.json` is not json.org's. `JSONObject.optString` on an EXPLICIT
     * JSON null returns the four-character string `"null"`, not the fallback:
     * `optString` delegates to `JSON.toString`, which reaches
     * `String.valueOf(JSONObject.NULL)` with no NULL guard (platform source,
     * android-35). Swift's `as? String` gives nil and JS gives null, so **neither
     * reference shell can show you this class of bug** — and `.ifEmpty { null }`,
     * the obvious guard, never fires, because `"null"` is not empty.
     *
     * The engine spells absent-but-present as JSON null throughout: `forceItem` on
     * every create-session, `instance` on every save-room, `cup`, `trackId`. Every
     * one of them silently became the literal string until this existed.
     */
    fun optStr(o: JSONObject, key: String): String? =
        if (o.isNull(key)) null else o.optString(key).ifEmpty { null }

    /** An argument. Null stays null: every `...OrNull` parameter needs one. */
    fun arg(s: String?): ByteArray? = s?.toByteArray(Charsets.UTF_8)

    /**
     * Parse a JSON answer. Returns an empty object rather than throwing: every
     * JSON-returning export either answers or answers emptily (`ttp_abi.h`'s
     * absent-singleton rule), so a parse failure means the C side was never
     * called — and a shell that crashed on it would turn a no-op into a black
     * screen.
     */
    fun obj(b: ByteArray?): JSONObject {
        val t = str(b) ?: return JSONObject()
        return try { JSONObject(t) } catch (_: Throwable) { JSONObject() }
    }

    fun arr(b: ByteArray?): JSONArray {
        val t = str(b) ?: return JSONArray()
        return try { JSONArray(t) } catch (_: Throwable) { JSONArray() }
    }

    /** A JSON array of strings, which several theme/model lists answer with. */
    fun strings(b: ByteArray?): List<String> {
        val a = arr(b)
        return (0 until a.length()).mapNotNull { a.optString(it, null) }
    }
}

/**
 * A player identity as the engine spells it: a **JSON scalar**, not a string.
 *
 * This type exists because the difference is invisible and load-bearing. Seat
 * ids arrive from the relay as either JSON numbers or JSON strings depending on
 * how a phone joined, and `3` and `"3"` are two different players to
 * `ttp::parse_scalar_id`. A Kotlin `String` holding `3` would be encoded as the
 * latter by any ordinary JSON call and silently address the wrong seat.
 */
@JvmInline
value class EngineId(val json: String) {

    /** For display and for map keys on the Kotlin side only — never as an argument. */
    val text: String
        get() = if (json.length >= 2 && json.startsWith("\"") && json.endsWith("\"")) {
            try { JSONArray("[$json]").getString(0) } catch (_: Throwable) { json }
        } else json

    /** The value to put INSIDE a JSONObject, so it re-encodes with its own type. */
    fun boxed(): Any = try { JSONArray("[$json]").get(0) } catch (_: Throwable) { json }

    companion object {
        fun number(n: Int) = EngineId(n.toString())

        fun string(s: String) = EngineId(JSONArray().put(s).toString().let {
            it.substring(1, it.length - 1)
        })

        /** Rebuild from a decoded JSON value (what a roster read hands back). */
        fun from(any: Any?): EngineId? = when (any) {
            null, JSONObject.NULL -> null
            is Int -> number(any)
            is Long -> EngineId(any.toString())
            is Number -> EngineId(JSONArray().put(any).toString().let {
                it.substring(1, it.length - 1)
            })
            is String -> string(any)
            else -> null
        }
    }
}
