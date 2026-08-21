package games.couchpad.tinytrack

import android.content.res.AssetManager
import android.util.Log
import org.json.JSONObject

/**
 * The info board's legal data: the two couchpad.games pages the QR cards encode,
 * and the attribution list the Licenses board renders.
 *
 * **NOTHING HERE IS TYPED.** `assets/legal/credits.json` is baked from
 * `public/shared/credits.js` plus the live music catalogue by
 * `shells/androidtv/scripts/gen-legal.mjs` — the same two modules the web's
 * /licenses.html renders — with the delta between what a browser ships and what
 * an .apk ships applied in one place, and the notice texts it names staged
 * beside it. A song added to a biome pool appears on the board after the next
 * stage with nothing edited. See the generator's header for that delta and
 * `tests/androidtv-legal.test.js` for what holds it honest.
 *
 * **The board is an obligation, not a courtesy.** The race music is CC-BY (the
 * credit IS the licence condition), the two fonts are OFL, and Filament,
 * openlibm, double-conversion, OkHttp, ZXing, AndroidX and the Kotlin standard
 * library all demand their notice travel with the build. A shell that ships
 * those and shows nobody is in breach, which is why this exists on a TV at all.
 *
 * Loaded ONCE, at boot, beside the tokens and the fonts — reading 12 KB of JSON
 * on the frame's thread the first time a viewer presses ⓘ is a stutter on the
 * one board that has nothing else to blame it on.
 */
object Legal {

    private const val TAG = "TinyTrackParty"

    /** Where the staged data and the texts it names live in the APK. */
    private const val DIR = "legal"

    /**
     * One credited work. [notice] is the license text this build SHIPS for it, as
     * a file name under `assets/legal`; entries without one are under a license
     * that demands no notice travel (CC0, CC-BY), and their row states its terms
     * rather than drilling into a text.
     */
    data class Entry(
        val section: String,
        val title: String,
        val author: String,
        val license: String,
        val licenseUrl: String,
        val url: String,
        val notice: String?,
    )

    /**
     * The two central legal pages. They are couchpad.games's, not this game's,
     * and a TV cannot open either — which is why the info board shows them as QR
     * codes for the phone the player is already holding.
     */
    var privacyUrl: String = ""
        private set
    var imprintUrl: String = ""
        private set

    /** The board's rows, in the shared credits' own order (grouped by section). */
    var entries: List<Entry> = emptyList()
        private set

    private lateinit var assets: AssetManager

    /** Read the staged data. Once at boot, before the first composition. */
    fun load(assets: AssetManager) {
        this.assets = assets
        val text = try {
            assets.open("$DIR/credits.json").use { it.readBytes() }.toString(Charsets.UTF_8)
        } catch (t: Throwable) {
            // A STAGING failure, not a design: stage-assets.sh generates this on
            // every build. Log it and leave the board empty rather than taking the
            // app down — an unreadable credits file is not a reason a party cannot
            // race, and the empty board says plainly that something is missing.
            Log.e(TAG, "legal: no $DIR/credits.json — run shells/androidtv/scripts/stage-assets.sh", t)
            return
        }
        val root = JSONObject(text)
        privacyUrl = root.optString("privacyUrl")
        imprintUrl = root.optString("imprintUrl")
        val rows = root.optJSONArray("entries") ?: return
        entries = (0 until rows.length()).mapNotNull { i ->
            val e = rows.optJSONObject(i) ?: return@mapNotNull null
            Entry(
                section = e.optString("section"),
                title = e.optString("title"),
                author = e.optString("author"),
                license = e.optString("license"),
                licenseUrl = e.optString("licenseUrl"),
                url = e.optString("url"),
                // `optStr`, not `optString`: a CC0 row's notice is an explicit
                // JSON null, which this platform's org.json reads as the string
                // "null" — see TtpJson.optStr. Every row would have claimed to
                // ship a license text called "null".
                notice = TtpJson.optStr(e, "notice"),
            )
        }
    }

    /**
     * The notice text for [entry], as staged, or null when this build ships none
     * for it.
     *
     * A missing FILE for an entry that names one is a build fault (the generator
     * copies exactly the set the entries name), so the screen says so rather than
     * showing an empty page that reads as "no licence".
     */
    fun notice(entry: Entry): String? {
        val name = entry.notice ?: return null
        return try {
            assets.open("$DIR/$name").use { it.readBytes() }.toString(Charsets.UTF_8)
        } catch (t: Throwable) {
            Log.e(TAG, "legal: '$name' is named by ${entry.title} and is not in the APK", t)
            null
        }
    }
}
