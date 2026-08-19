package com.couchgames.tinytrackparty

import android.content.res.AssetManager
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.StringReader

/**
 * The four held-item icons: the SHARED SVGs every shell draws —
 * `public/assets/items/<key>.svg`, staged verbatim into `assets/items/`. One file
 * per item id is the whole design (shells.md item 11): the web inlines the same
 * bytes into the DOM, tvOS hands them to SwiftDraw, and this shell draws them
 * into a Compose canvas. There is no per-shell artwork to drift.
 *
 * **THE TWO RECOLOUR SEAMS ARE CSS CUSTOM PROPERTIES**, which nothing here
 * evaluates — so this shell does what the ledger says a shell without CSS does:
 * SUBSTITUTE the token, then draw.
 *
 *   `--icon-accent`  the boost chevrons' stroke: the BIOME's boost accent
 *                    (`ttp_theme_boost_icon`), picked for contrast with this
 *                    track's deck. The fallback baked into the file is the
 *                    pre-theme teal.
 *   `--icon-car`     the monster cab's fill: the body tone of the car MODEL the
 *                    player drives — the 2D echo of the in-race graft, which
 *                    stands the player's own body on the kit chassis. NOT the
 *                    livery, which only ever paints the name chip.
 *
 * ## Why there is a parser here rather than a library
 *
 * Android has no SVG rasterizer. Across all four files the vocabulary is nine
 * `<path>`, five `<circle>`, two `<polyline>` and two `<g transform>`, and the
 * path data is handled by `androidx.core.graphics.PathParser`, which ships in a
 * dependency this app already has. A general SVG library would be a megabyte to
 * read four files whose whole grammar is listed in [Node].
 *
 * **It is deliberately not general.** An element or transform it does not know is
 * DROPPED rather than approximated, because a silently half-drawn icon in a
 * 152-pixel slot glanced at from a sofa is worse than an empty one. Nothing
 * reports it: a parse failure returns null and the slot draws empty. Adding a
 * report would mean a channel this object does not have, and the four files it
 * reads are staged from the repo by a script that fails loudly on a missing one.
 */
object ItemIcon {

    /**
     * `boostShades()`' own pre-theme teal, for a slot drawn before any scene has
     * resolved a biome. The same literal the SVG carries as its fallback.
     */
    const val DEFAULT_ACCENT = 0x12A99A

    /**
     * `CAR_BODY_COLORS` (`public/shared/itemIcons.js`): one body tone per car
     * MODEL, in `CAR_MODELS` order, sampled from the baked thumbs so the chip
     * matches the car it stands for. A sanctioned second spelling;
     * `tests/item-icons.test.js` holds it to the JS entry for entry.
     */
    val CAR_BODY_COLORS = intArrayOf(
        0x5CBB80,   // vehicle-racer-low · Dash
        0xDD5533,   // vehicle-speedster · Bolt
        0x6688CC,   // vehicle-racer · Carve
        0xAA77DD,   // vehicle-vintage-racer · Rumble
    )

    /**
     * Parsed documents, MISSES INCLUDED. The value is boxed because
     * `HashMap.getOrPut` treats a stored null as absent, so caching a failure as a
     * bare null re-opened and re-reparsed an unreadable file on every recomposition
     * of every cell's item slot, at 6 Hz.
     */
    private val sources = HashMap<String, Optional<Doc>>()

    /** A cacheable "parsed, and the answer was nothing". */
    private class Optional<T>(val value: T?)

    private lateinit var assets: AssetManager

    fun attach(assetManager: AssetManager) { assets = assetManager }

    /**
     * Draw item [key] into the given box.
     *
     * No placeholder for a missing icon. An unstaged file leaves the slot's card
     * empty, which is honest — the slot itself still says an item is held, and a
     * question mark would read as a fifth item.
     */
    @Composable
    fun Draw(
        key: String,
        modifier: Modifier = Modifier,
        accent: Int = DEFAULT_ACCENT,
        carIndex: Int = 0,
    ) {
        val doc = source(key) ?: return
        val car = CAR_BODY_COLORS[
            ((carIndex % CAR_BODY_COLORS.size) + CAR_BODY_COLORS.size) % CAR_BODY_COLORS.size
        ]
        Canvas(modifier) { doc.draw(this, accent, car) }
    }

    private fun source(key: String): Doc? = sources.getOrPut(key) { Optional(readDoc(key)) }.value

    private fun readDoc(key: String): Doc? {
        val text = try {
            assets.open("items/$key.svg").use { it.readBytes() }.toString(Charsets.UTF_8)
        } catch (_: Throwable) {
            return null
        }
        // The authored comments NAME the CSS tokens ("--icon-accent"), and a literal
        // `--` inside an XML comment is ILLEGAL XML. A browser's lenient HTML parser
        // shrugs; a real XML parser refuses the whole file, which on tvOS rendered
        // every slot as an empty card. Comments carry no geometry, so they go before
        // the parser sees them — and BEFORE the token scan, since the comments are
        // where the tokens are described and a file that merely TALKS about
        // `--icon-car` would otherwise claim to vary by it.
        return parse(text.replace(Regex("(?s)<!--.*?-->"), ""))
    }

    // -- the document -------------------------------------------------------

    private class Doc(
        val viewW: Float,
        val viewH: Float,
        val nodes: List<Node>,
    ) {
        fun draw(scope: DrawScope, accent: Int, car: Int) = with(scope) {
            // `preserveAspectRatio` defaults to meet/xMidYMid, and every one of
            // these files is a square viewBox in a square slot — so this is a
            // uniform fit with no letterbox to compute.
            val s = minOf(size.width / viewW, size.height / viewH)
            withTransform({
                translate((size.width - viewW * s) / 2f, (size.height - viewH * s) / 2f)
                scale(s, s, Offset.Zero)
            }) {
                for (n in nodes) n.draw(this, accent, car, s)
            }
        }
    }

    /**
     * One drawable element, already resolved against its inherited presentation
     * attributes. The whole grammar these four files use.
     */
    private class Node(
        val path: Path,
        val fill: Paintish?,
        val stroke: Paintish?,
        val strokeWidth: Float,
        val cap: StrokeCap,
        val join: StrokeJoin,
    ) {
        fun draw(scope: DrawScope, accent: Int, car: Int, viewScale: Float) = with(scope) {
            fill?.let { drawPath(path, it.resolve(accent, car)) }
            stroke?.let {
                drawPath(
                    path, it.resolve(accent, car),
                    // The stroke width is in USER units and the canvas is already
                    // scaled, so it does NOT get multiplied again here.
                    style = Stroke(width = strokeWidth, cap = cap, join = join),
                )
            }
        }
    }

    /** A colour, or one of the two CSS tokens standing in for one. */
    private class Paintish(val rgb: Int, val token: Int) {
        fun resolve(accent: Int, car: Int): Color = when (token) {
            TOKEN_ACCENT -> Color(0xFF000000.toInt() or accent)
            TOKEN_CAR -> Color(0xFF000000.toInt() or car)
            else -> Color(0xFF000000.toInt() or rgb)
        }

        companion object {
            const val TOKEN_NONE = 0
            const val TOKEN_ACCENT = 1
            const val TOKEN_CAR = 2
        }
    }

    // -- parsing ------------------------------------------------------------

    private class Attrs(
        val fill: Paintish?,
        val stroke: Paintish?,
        val strokeWidth: Float,
        val cap: StrokeCap,
        val join: StrokeJoin,
    )

    private fun parse(xml: String): Doc? {
        val parser = try {
            XmlPullParserFactory.newInstance().newPullParser().apply {
                setInput(StringReader(xml))
            }
        } catch (_: Throwable) { return null }

        var viewW = 24f
        var viewH = 24f
        val nodes = ArrayList<Node>()
        // Inherited presentation attributes, one frame per open element.
        val stack = ArrayList<Attrs>()
        // Accumulated <g transform>, applied to geometry as it is built. These
        // files only ever nest one deep, but a stack costs nothing and removes the
        // question.
        val transforms = ArrayList<android.graphics.Matrix>()

        fun current(): Attrs = stack.lastOrNull()
            ?: Attrs(null, null, 1f, StrokeCap.Butt, StrokeJoin.Miter)

        try {
            var ev = parser.eventType
            while (ev != XmlPullParser.END_DOCUMENT) {
                when (ev) {
                    XmlPullParser.START_TAG -> {
                        val inherited = current()
                        val attrs = Attrs(
                            // THREE states, not two. `?: inherited` would treat an
                            // explicit `none` as absent and inherit the root's paint
                            // — rocket.svg's porthole (fill #2d9cdb, stroke="none")
                            // would take the root's 2.2-wide red outline and draw as
                            // a red blob, and monster.svg's two wheel hubs the same.
                            // SVG says `none` OVERRIDES the inherited value.
                            fill = resolve(parser.getAttributeValue(null, "fill"), inherited.fill),
                            stroke = resolve(parser.getAttributeValue(null, "stroke"), inherited.stroke),
                            strokeWidth = parser.getAttributeValue(null, "stroke-width")
                                ?.toFloatOrNull() ?: inherited.strokeWidth,
                            cap = when (parser.getAttributeValue(null, "stroke-linecap")) {
                                "round" -> StrokeCap.Round
                                "square" -> StrokeCap.Square
                                "butt" -> StrokeCap.Butt
                                else -> inherited.cap
                            },
                            join = when (parser.getAttributeValue(null, "stroke-linejoin")) {
                                "round" -> StrokeJoin.Round
                                "bevel" -> StrokeJoin.Bevel
                                "miter" -> StrokeJoin.Miter
                                else -> inherited.join
                            },
                        )
                        stack.add(attrs)

                        val t = matrix(parser.getAttributeValue(null, "transform"))
                        transforms.add(t ?: android.graphics.Matrix())

                        when (parser.name) {
                            "svg" -> parser.getAttributeValue(null, "viewBox")
                                ?.trim()?.split(Regex("[ ,]+"))
                                ?.mapNotNull { it.toFloatOrNull() }
                                ?.takeIf { it.size == 4 }
                                ?.let { viewW = it[2]; viewH = it[3] }

                            "path" -> parser.getAttributeValue(null, "d")?.let { d ->
                                node(pathFrom(d), attrs, transforms)?.let(nodes::add)
                            }

                            "circle" -> {
                                val cx = parser.getAttributeValue(null, "cx")?.toFloatOrNull() ?: 0f
                                val cy = parser.getAttributeValue(null, "cy")?.toFloatOrNull() ?: 0f
                                val r = parser.getAttributeValue(null, "r")?.toFloatOrNull() ?: 0f
                                val p = android.graphics.Path().apply {
                                    addCircle(cx, cy, r, android.graphics.Path.Direction.CW)
                                }
                                node(p, attrs, transforms)?.let(nodes::add)
                            }

                            "polyline" -> {
                                val pts = parser.getAttributeValue(null, "points")
                                    ?.trim()?.split(Regex("[ ,]+"))
                                    ?.mapNotNull { it.toFloatOrNull() } ?: emptyList()
                                if (pts.size >= 4) {
                                    val p = android.graphics.Path()
                                    p.moveTo(pts[0], pts[1])
                                    var i = 2
                                    while (i + 1 < pts.size) { p.lineTo(pts[i], pts[i + 1]); i += 2 }
                                    // A polyline is NOT closed and is never filled
                                    // by these files; passing the inherited fill
                                    // would paint the chevrons solid.
                                    node(p, Attrs(null, attrs.stroke, attrs.strokeWidth,
                                        attrs.cap, attrs.join), transforms)?.let(nodes::add)
                                }
                            }

                            "g" -> Unit   // a transform frame only; already pushed
                        }
                    }

                    XmlPullParser.END_TAG -> {
                        if (stack.isNotEmpty()) stack.removeAt(stack.size - 1)
                        if (transforms.isNotEmpty()) transforms.removeAt(transforms.size - 1)
                    }
                }
                ev = parser.next()
            }
        } catch (_: Throwable) {
            return null
        }
        return Doc(viewW, viewH, nodes)
    }

    private fun node(
        raw: android.graphics.Path, a: Attrs, transforms: List<android.graphics.Matrix>,
    ): Node? {
        if (a.fill == null && a.stroke == null) return null
        // Bake the accumulated <g> transforms into the geometry, so drawing is a
        // flat list with no state to restore.
        //
        // preConcat, walking OUTERMOST FIRST: SVG composes a nested transform as
        // `T_root x T_child`, and postConcat over the same order builds
        // `T_child x T_root` — the inverse composition. The four files this reads
        // have one level with an identity root, so it made no difference to any
        // pixel; it would to the first icon with a nested <g>.
        val m = android.graphics.Matrix()
        for (t in transforms) m.preConcat(t)
        if (!m.isIdentity) raw.transform(m)
        return Node(raw.asComposePath(), a.fill, a.stroke, a.strokeWidth, a.cap, a.join)
    }

    private fun pathFrom(d: String): android.graphics.Path =
        androidx.core.graphics.PathParser.createPathFromPathData(d)

    /**
     * `translate(x y)` and `rotate(a cx cy)` — the two these files use. Anything
     * else returns null and the element draws untransformed, which is visibly
     * wrong rather than subtly wrong, and so gets noticed.
     */
    private fun matrix(text: String?): android.graphics.Matrix? {
        if (text.isNullOrBlank()) return null
        val m = android.graphics.Matrix()
        val translate = Regex("translate\\(([^)]*)\\)").find(text)
        if (translate != null) {
            val n = translate.groupValues[1].trim().split(Regex("[ ,]+")).mapNotNull { it.toFloatOrNull() }
            if (n.isNotEmpty()) m.postTranslate(n[0], n.getOrElse(1) { 0f })
        }
        val rotate = Regex("rotate\\(([^)]*)\\)").find(text)
        if (rotate != null) {
            val n = rotate.groupValues[1].trim().split(Regex("[ ,]+")).mapNotNull { it.toFloatOrNull() }
            if (n.size >= 3) m.postRotate(n[0], n[1], n[2]) else if (n.isNotEmpty()) m.postRotate(n[0])
        }
        return m
    }

    /** Absent -> inherit; explicit `none` -> no paint; otherwise the parsed one. */
    private fun resolve(text: String?, inherited: Paintish?): Paintish? = when {
        text == null -> inherited
        text.trim() == "none" -> null
        else -> paint(text) ?: inherited
    }

    /**
     * `#rrggbb`, `#rgb`, or a `var(--token, fallback)` expression. The whole
     * var() goes — the token's value is resolved at draw time, which is the
     * substitution the ledger asks of a shell that cannot evaluate CSS.
     */
    private fun paint(text: String): Paintish? {
        val t = text.trim()
        if (t.startsWith("var(")) {
            return when {
                t.contains("--icon-accent") -> Paintish(DEFAULT_ACCENT, Paintish.TOKEN_ACCENT)
                t.contains("--icon-car") -> Paintish(CAR_BODY_COLORS[3], Paintish.TOKEN_CAR)
                else -> null
            }
        }
        if (!t.startsWith("#")) return null
        val hex = t.substring(1)
        val rgb = when (hex.length) {
            3 -> {
                val r = hex[0].digitToIntOrNull(16) ?: return null
                val g = hex[1].digitToIntOrNull(16) ?: return null
                val b = hex[2].digitToIntOrNull(16) ?: return null
                (r * 17 shl 16) or (g * 17 shl 8) or (b * 17)
            }
            6 -> hex.toIntOrNull(16) ?: return null
            else -> return null
        }
        return Paintish(rgb, Paintish.TOKEN_NONE)
    }
}
