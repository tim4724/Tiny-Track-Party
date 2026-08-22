package games.couchpad.tinytrack

import android.content.res.AssetManager
import android.util.Log
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * The "Sticker Bash" palette, read at boot from the SAME file the web's CSS is
 * baked to.
 *
 * `public/shared/theme.css` is the authored source of the look;
 * `scripts/gen-design-tokens.mjs` bakes its `:root` block to
 * `public/shared/design-tokens.json` (typed, aliases resolved), and
 * `stage-assets.sh` copies that file verbatim into `assets/`. Reading it here
 * rather than transcribing hex is not tidiness: it is the mitigation
 * `docs/native-port/architecture.md` accepted when it allowed three
 * implementations of the sticker look. A hex literal in Kotlin is a fourth
 * source that nothing in the tree watches, and `--accent` has already moved once
 * (amber → red).
 *
 * So: **no colour or length that exists in `design-tokens.json` may be spelled
 * again in Kotlin.**
 *
 * ## Lengths are AUTHORED PIXELS, and that is why they are returned as `Dp`
 *
 * The app installs a [LocalDensity] override at its root
 * (`density = windowWidthPx / 1920f`), under which one `dp` is one authored
 * pixel — the same number `theme.css` writes and the same number the tvOS Swift
 * writes as a point. So a token's px value becomes a `Dp` with no arithmetic,
 * exactly as it does on tvOS. See `shells/androidtv/CLAUDE.md`.
 */
object Tokens {

    /**
     * A hard offset shadow. Every one in this design system has **zero blur** —
     * that is what makes a sticker read as die-cut rather than as a floating
     * card, and it is why `blur` is carried but has always been 0.
     */
    data class Shadow(val x: Dp, val y: Dp, val blur: Dp, val color: Color)

    private val colors = HashMap<String, Color>()
    private val lengths = HashMap<String, Dp>()
    private val shadows = HashMap<String, Shadow>()
    private val numbers = HashMap<String, Float>()

    /**
     * The `car-*` group **in file order**. That order is the `colorIndex` a seat
     * carries, so it may not be sorted or reordered.
     */
    private val liveries = ArrayList<Color>()
    private var loaded = false

    /**
     * What a missing token resolves to. Screaming magenta on purpose: it is in
     * neither the chrome palette nor the livery palette, so a token that failed
     * to load is unmistakable in a screenshot instead of quietly blending into
     * the paper. Same reasoning as [Copy]'s `[key?]`.
     */
    private val missing = Color(1f, 0f, 1f, 1f)

    /**
     * Read `assets/design-tokens.json`. Call once at boot, before the first
     * composition.
     *
     * A failure stops a developer and limps in release — see [tokenRequire], which
     * is what makes that true. It must NOT be `kotlin.assert`.
     */
    fun load(assets: AssetManager) {
        if (loaded) return
        loaded = true

        val text = try {
            assets.open("design-tokens.json").use { it.readBytes() }.toString(Charsets.UTF_8)
        } catch (_: Throwable) {
            tokenRequire(false) { "design-tokens.json is not in the APK — run shells/androidtv/scripts/stage-assets.sh" }
            return
        }
        val root = try { JSONObject(text) } catch (_: Throwable) {
            tokenRequire(false) { "design-tokens.json did not parse" }
            return
        }
        val entries = root.optJSONArray("tokens") ?: run {
            tokenRequire(false) { "design-tokens.json did not parse as { tokens: [...] }" }
            return
        }

        for (i in 0 until entries.length()) {
            val e = entries.optJSONObject(i) ?: continue
            val name = e.optString("name", "")
            when (e.optString("type", "")) {
                // The bake resolves aliases AND pre-splits every colour into
                // `rgba`, so there is no hex parser here and no `color-mix` to
                // evaluate. That pre-splitting is the whole point of the typed
                // bake — three shells parsing CSS colour syntax three ways is
                // exactly the drift it removes.
                "color" -> rgba(e.opt("rgba"))?.let { colors[name] = it }
                "length" -> if (e.has("px")) lengths[name] = e.getDouble("px").toFloat().dp
                // A bare number, which the bake cannot type as anything better:
                // the safe-zone insets are FRACTIONS of a surface, and a fraction
                // has no unit for `length` to have parsed. Anything raw that is
                // not a number (a font stack, a keyword) simply does not land
                // here, which is why this is a filter and not a cast.
                "raw" -> e.optString("resolved", "").trim().toFloatOrNull()
                    ?.let { numbers[name] = it }
                "shadow" -> {
                    val s = e.optJSONObject("shadow") ?: continue
                    val c = rgba(s.opt("rgba")) ?: continue
                    shadows[name] = Shadow(
                        s.optDouble("x", 0.0).toFloat().dp,
                        s.optDouble("y", 0.0).toFloat().dp,
                        s.optDouble("blur", 0.0).toFloat().dp,
                        c,
                    )
                }
                // "font-stack" is deliberately ignored. The stack names the CSS
                // families the browser resolves through @font-face; the faces
                // THIS app can ask for are the static TTFs gen-fonts.py renamed,
                // which the stack does not spell. Type lives in Fonts.kt.
            }
        }

        // Order-preserving, and taken by PREFIX rather than by the group's label
        // so a reworded CSS comment cannot silently reshuffle the liveries.
        // (`--car`, the semantic role, does not match "car-".)
        for (i in 0 until entries.length()) {
            val name = entries.optJSONObject(i)?.optString("name", "") ?: continue
            if (name.startsWith("car-")) colors[name]?.let { liveries.add(it) }
        }

        assertWhole(if (root.has("count")) root.getInt("count") else null, entries.length())
    }

    /**
     * A file that parses but is SHORT is the dangerous case: every token it
     * dropped resolves to magenta, and a half-magenta screen looks like a
     * theming mistake rather than a staging one. Two checks, because they catch
     * different failures — the bake's own `count` catches a truncated copy, the
     * required-name sweep catches a bake that renamed something.
     */
    private fun assertWhole(declared: Int?, parsed: Int) {
        tokenRequire(declared == null || declared == parsed) {
            "design-tokens.json declares $declared tokens but $parsed parsed — stale copy?"
        }
        for (n in listOf("paper", "ink", "ink-2", "ink-3", "red", "green", "blue", "purple",
            "brand", "accent", "danger", "item", "surface", "surface-2", "hairline",
            "grass", "shadow-ink", "btn-ledge")) {
            tokenRequire(colors[n] != null) { "design-tokens.json is missing --$n" }
        }
        tokenRequire(liveries.size == 8) { "expected 8 car liveries, got ${liveries.size}" }
        for (n in listOf("r-sm", "r", "r-lg", "r-pill", "btn-drop", "btn-sink")) {
            tokenRequire(lengths[n] != null) { "design-tokens.json is missing the length --$n" }
        }
        for (n in listOf("shadow-pop", "shadow-card", "shadow-float")) {
            tokenRequire(shadows[n] != null) { "design-tokens.json is missing the shadow --$n" }
        }
        for (n in listOf("safe-frac-x", "safe-frac-y", "steer-band-frac",
            "track-map-casing", "track-map-road",
            "track-map-start-r", "track-map-start-ring")) {
            tokenRequire(numbers[n] != null) { "design-tokens.json is missing the number --$n" }
        }
        // The one rule the CSS can only state in prose, and the reason
        // tests/design-tokens.test.js exists on the web side: press travel equal
        // to the ledge depth would punch the button through its own ledge and
        // flatten it. Sticker.kt's button geometry is built on the difference.
        tokenRequire(length("btn-sink") < length("btn-drop")) { "--btn-sink must stay under --btn-drop" }
    }

    private fun rgba(any: Any?): Color? {
        val a = any as? org.json.JSONArray ?: return null
        if (a.length() != 4) return null
        // The bake writes r/g/b in 0..255 and alpha in 0..1, and Color's
        // component constructor is sRGB — the same space a CSS hex is in.
        return Color(
            (a.getDouble(0) / 255.0).toFloat(),
            (a.getDouble(1) / 255.0).toFloat(),
            (a.getDouble(2) / 255.0).toFloat(),
            a.getDouble(3).toFloat(),
        )
    }

    // -- lookup -------------------------------------------------------------

    /** By raw token name, kebab-case exactly as the CSS spells it minus the `--`. */
    fun color(name: String): Color = colors[name] ?: missing.also {
        tokenRequire(false) { "no design token --$name" }
    }

    /** Any length token, in AUTHORED pixels — which under the root density override is `dp`. */
    fun length(name: String): Dp = lengths[name] ?: 0.dp.also {
        tokenRequire(false) { "no length token --$name" }
    }

    fun radius(name: String): Dp = length(name)

    /**
     * A unitless token as a number, or null when the bake does not carry it.
     *
     * NULL RATHER THAN A DEFAULT, unlike [color] and [length], because the one
     * caller has a better fallback than this file could invent: the safe insets
     * default to 2.5% in C++, and a zero pushed from here would replace that with
     * no safe zone at all. The caller skips the push instead.
     */
    fun number(name: String): Float? = numbers[name]

    /**
     * The TV overscan margin a FULL-SCREEN board keeps clear of each edge, in
     * authored px — so `dp` under the root density override, and 48 x 27 at the
     * 2.5% the token declares. Google's TV guidance asks for double that (its
     * 48 x 27 is against a 960 x 540 dp layout, which is 96 x 54 here); the
     * token's own note in `theme.css` says why this tree does not follow it.
     *
     * **The per-cell HUD does not use these.** Its rects arrive already inset
     * from `ttp_display_cell_rects`, because only C++ knows which of a cell's
     * edges are screen edges — a stacked pair's shared divider is not one, and
     * padding it would be a margin against nothing. These are for the boards
     * that really do run to the bezel.
     *
     * Zero if the bake is missing them, which is [assertWhole]'s complaint to
     * make and not this accessor's — same as [length].
     */
    val safeMarginX: Dp get() = ((number("safe-frac-x") ?: 0f) * AUTHORED_WIDTH).dp
    val safeMarginY: Dp get() = ((number("safe-frac-y") ?: 0f) * AUTHORED_HEIGHT).dp

    /**
     * How far up from the bottom of a split-screen cell that cell's STEER BAR
     * reaches, in authored px. The bar is the renderer's, so this is a token and
     * not a number to re-measure here — see `--steer-band-frac` in `theme.css`
     * for what composes it and which layouts it covers.
     */
    val steerBand: Dp get() = ((number("steer-band-frac") ?: 0f) * AUTHORED_HEIGHT).dp

    fun shadow(name: String): Shadow =
        shadows[name] ?: Shadow(0.dp, 0.dp, 0.dp, Color.Transparent).also {
            tokenRequire(false) { "no shadow token --$name" }
        }

    /**
     * A player's livery, by the `colorIndex` a seat carries. Wrapping, with the
     * same negative-safe modulo `protocol.h`'s `car_stats` uses.
     *
     * **These are LIVERIES, not chrome.** Chrome in this design system is
     * red / green / blue / purple ONLY — amber, pink, orange and cyan exist in
     * this palette and nowhere else in the UI. Do not reach for `car(1)` because
     * a button wants to be yellow; that veto is the whole reason the two
     * palettes are separate groups in `theme.css`.
     */
    fun car(index: Int): Color {
        if (liveries.isEmpty()) return missing
        val n = liveries.size
        return liveries[((index % n) + n) % n]
    }

    /**
     * Assert the livery palette still matches the engine's `CAR_COLORS`.
     *
     * There are two ABI-visible spellings of these eight colours in this app:
     * this file's (via `theme.css`, whose own comment says it mirrors
     * `CAR_COLORS`) and `ttp_protocol_manifest_json()`'s, which is the sanctioned
     * port source named in CLAUDE.md. Two spellings of one fact is what the
     * manifest rule forbids, and the web resolves it with
     * `tests/config-drift.test.js`. This is that check, in the only place an
     * Android build can see both lists at once. Debug only, and called after the
     * engine is up — not from [load], where it is not.
     */
    fun assertLiveriesMatchEngine() {
        if (!BuildConfigIsDebug) return
        val engine = TtpJson.obj(Ttp.ttp_protocol_manifest_json()).optJSONArray("CAR_COLORS")
        if (engine == null) {
            tokenRequire(false) { "ttp_protocol_manifest_json() carries no CAR_COLORS" }
            return
        }
        tokenRequire(engine.length() == liveries.size) {
            "CAR_COLORS has ${engine.length()} entries, design-tokens.json has ${liveries.size}"
        }
        for (i in 0 until minOf(engine.length(), liveries.size)) {
            val want = engine.optString(i, "").lowercase()
            tokenRequire(hexRGB(liveries[i]) == want) {
                "livery $i: engine says $want, design-tokens.json says ${hexRGB(liveries[i])}"
            }
        }
    }

    /** `#rrggbb`, lowercase — the spelling `protocol.h` uses. */
    private fun hexRGB(c: Color): String = String.format(
        "#%02x%02x%02x",
        Math.round(c.red * 255f), Math.round(c.green * 255f), Math.round(c.blue * 255f),
    )

    // -- named accessors ----------------------------------------------------

    val paper get() = color("paper")
    val ink get() = color("ink")
    val ink2 get() = color("ink-2")
    val ink3 get() = color("ink-3")
    val red get() = color("red")
    val green get() = color("green")
    val blue get() = color("blue")
    val purple get() = color("purple")
    val brand get() = color("brand")
    val accent get() = color("accent")
    val danger get() = color("danger")
    val surface get() = color("surface")
    val surface2 get() = color("surface-2")
    val hairline get() = color("hairline")
    val grass get() = color("grass")
    val shadowInk get() = color("shadow-ink")
    val btnLedge get() = color("btn-ledge")
}

/**
 * What `kotlin.assert` was supposed to be here, and is not.
 *
 * **`kotlin.assert` IS A NO-OP ON ANDROID.** It compiles to
 * `if (kotlin._Assertions.ENABLED) throw AssertionError(...)`, and that flag is
 * `javaClass.desiredAssertionStatus()`, which ART answers `false` for in every
 * build — debug included, because Android has no `-ea`. Every check in this file
 * was dead code: an unstaged design-tokens.json gave a screaming-magenta UI with
 * zero radii, no log line and no crash, and `assertLiveriesMatchEngine` — which
 * exists specifically to catch the liveries drifting from the engine's CAR_COLORS
 * — never ran. The tvOS twin's `assertionFailure` does fire; this was a
 * transcription that lost its teeth.
 *
 * Logs ALWAYS, so a release build says what went wrong, and throws only in debug,
 * because crashing a shipping TV app over a chrome colour is worse than painting
 * it magenta.
 */
internal inline fun tokenRequire(ok: Boolean, why: () -> String) {
    if (ok) return
    val message = why()
    Log.e("TtpTokens", message)
    if (BuildConfigIsDebug) throw IllegalStateException(message)
}

/**
 * `BuildConfig.DEBUG` without depending on the generated class, so this file
 * compiles in isolation and in a unit test.
 */
internal val BuildConfigIsDebug: Boolean =
    try {
        Class.forName("games.couchpad.tinytrack.BuildConfig")
            .getField("DEBUG").getBoolean(null)
    } catch (_: Throwable) {
        false
    }
