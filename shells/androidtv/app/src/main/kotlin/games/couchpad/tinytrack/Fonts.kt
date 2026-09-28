package games.couchpad.tinytrack

import android.content.res.AssetManager
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

/**
 * The web's two families, as the static faces Android can actually load.
 *
 * `theme.css` ships ONE variable woff2 per family and lets the browser
 * interpolate the weight axis. Neither half survives the port: Android's font
 * loader cannot read woff2 at all. `shells/tvos/scripts/gen-fonts.py` bakes the
 * weights the design system actually names (200/300/600/700/800, scraped from
 * the CSS rather than guessed) into static TTFs, and `stage-assets.sh` copies
 * those into `assets/fonts/`.
 *
 * `--font-display` is Fredoka (headings, numerals, buttons, chips, the wordmark,
 * the countdown — "everything display-ish"); `--font-body` is Nunito, which the
 * display uses for its rare running text.
 *
 * TV VIEWING DISTANCE: there is no scale factor in here. The web's sizes are
 * authored for a monitor at arm's length and would be timid across a room, but
 * baking a global multiplier would make every call site lie about what it asked
 * for, and the two boards that need the most correction (the wordmark, the
 * countdown) carry their own poster scale. Callers pass a TV-appropriate size.
 *
 * Loaded FROM ASSETS rather than `res/font/`, because a resource name may not
 * contain a capital or a dash and the staged files are `Fredoka-SemiBold.ttf`.
 * Renaming them for the resource system would put a second spelling of each face
 * between the bake and this file.
 */
object Fonts {

    /**
     * Only the weights `gen-fonts.py` bakes. Fredoka's variable axis stops at
     * 700, so there is nothing heavier to bake and `.ExtraBold`/`.Black` requests
     * CLAMP to Bold — exactly as the browser clamps `font-weight: 800` past a
     * declared `300 700` range. Do not "fix" this by faking a heavier face with
     * a stroke; the wordmark's weight comes from its poster SIZE.
     */
    private val FREDOKA = listOf(300 to "Light", 600 to "SemiBold", 700 to "Bold")

    /** Nunito's axis runs to 1000 and covers every weight the CSS names. */
    private val NUNITO = listOf(
        200 to "ExtraLight", 300 to "Light", 600 to "SemiBold",
        700 to "Bold", 800 to "ExtraBold",
    )

    lateinit var display: FontFamily
        private set
    lateinit var body: FontFamily
        private set

    /**
     * Build both families. Once at boot, before the first composition.
     *
     * A FontFamily carrying every baked face lets Compose resolve
     * `fontWeight = FontWeight(600)` itself, which is the same "nearest face"
     * job `Fonts.swift` does by hand — the difference is that Compose's resolver
     * is the platform's, so a weight the design system does not bake resolves the
     * way the rest of the system resolves it.
     */
    fun load(assets: AssetManager) {
        display = family("Fredoka", FREDOKA, assets)
        body = family("Nunito", NUNITO, assets)
    }

    private fun family(name: String, faces: List<Pair<Int, String>>, assets: AssetManager) =
        FontFamily(faces.map { (weight, style) ->
            Font(path = "fonts/$name-$style.ttf", assetManager = assets,
                weight = FontWeight(weight))
        })

    /**
     * The weights the design system actually contains, named so a call site does
     * not spell a number the bake has no face for.
     *
     * Note what is absent: 400. The CSS never asks for it, so no 400 face is
     * baked, and "normal body text" in this look is Light (300) for Nunito and
     * [semibold] for Fredoka. 400 is simply not a weight this design contains.
     */
    val semibold = FontWeight(600)
    val bold = FontWeight(700)
}
