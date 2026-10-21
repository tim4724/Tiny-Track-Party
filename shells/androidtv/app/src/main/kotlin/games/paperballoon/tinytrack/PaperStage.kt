package games.paperballoon.tinytrack

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.dp

/**
 * The full-screen backdrop that boards sit on: `theme.css`'s `.scene` — a pale
 * sky, two rolling hills, three soft clouds, a flat grass band. Decorative only;
 * it never takes focus and never eats a remote press.
 *
 * **WHERE THIS MAY GO.** Paper backgrounds are for FULL-SCREEN BOARDS only — the
 * lobby before a track is picked, and the legal boards. Chrome that floats over
 * the live 3D view floats BARE: no paper, no panel behind it. Putting a
 * [PaperStage] behind the race HUD would break that.
 *
 * (There is no sun. It was yellow, and yellow is vetoed in chrome.)
 *
 * ONE CANVAS, unlike the tvOS version's nested views. Every element here is a
 * fill with no text, no focus and no hit testing, so a composed subtree per cloud
 * would buy nothing and cost a layout pass on a GPU that has none to spare.
 *
 * The scenery colours are literals, as they are in the CSS: the bake carries only
 * `:root`, and these are stage scenery rather than part of the design system.
 * The grass is the one token (`--grass`).
 */
@Composable
fun PaperStage(modifier: Modifier = Modifier) {
    Canvas(modifier.fillMaxSize()) { backdrop() }
}

private fun DrawScope.backdrop() {
    val w = size.width
    val h = size.height

    // `linear-gradient(180deg, #CFE7F7 0%, #EAF4FB 55%, #F3F8FC 100%)`.
    drawRect(Brush.verticalGradient(
        0f to Color(0xFFCFE7F7), 0.55f to Color(0xFFEAF4FB), 1f to Color(0xFFF3F8FC),
    ))

    // Rolling hills peeking over the grass band (`.scene__sky::before/::after`).
    drawOval(
        Color(0xFFBFE3A6),
        topLeft = Offset(-0.16f * w, h - 0.11f * h - 0.30f * h),
        size = Size(0.74f * w, 0.30f * h),
    )
    drawOval(
        Color(0xFFA9D98C),
        topLeft = Offset(w + 0.20f * w - 0.82f * w, h - 0.09f * h - 0.36f * h),
        size = Size(0.82f * w, 0.36f * h),
    )

    // Clouds, at the sizes and positions the CSS gives in px.
    //
    // **A DrawScope IS IN PHYSICAL PIXELS, never dp** — the root density override
    // buys the Compose layout tree its 1 dp == 1 authored px, and buys a Canvas
    // body nothing at all. So every ABSOLUTE length here is multiplied by `u`,
    // one authored pixel in this canvas's units. It reads as a no-op on a 1080p
    // panel, where the override makes density exactly 1.0 and `u` is 1 — and that
    // is precisely why bare literals survived: on the 4K output this box drives,
    // density is 2.0 and unscaled clouds drew at HALF size. Fractions of `w`/`h`
    // are already resolution-free and take no `u`.
    val u = 1.dp.toPx()
    cloud(0.34f * w, 0.09f * h, 150f * u, 42f * u, -2f,
        listOf(Hump(62f * u, 24f * u, -26f * u), Hump(46f * u, 82f * u, -16f * u)))
    cloud(w - 0.23f * w - 104f * u, 0.20f * h, 104f * u, 30f * u, 2f,
        listOf(Hump(44f * u, 18f * u, -18f * u), Hump(34f * u, 54f * u, -11f * u)))
    cloud(w - 0.09f * w - 84f * u, 0.36f * h, 84f * u, 26f * u, -2f,
        listOf(Hump(36f * u, 14f * u, -15f * u), Hump(28f * u, 44f * u, -9f * u)))

    // The grass band bleeds 2% past each edge so its rounded top never shows a
    // corner. `border-radius: 50% 50% 0 0 / 22% 22% 0 0` — both top corners have
    // rx = 50% of the width, so the two quarter-ellipses meet in the middle and
    // the whole top edge is ONE half-ellipse of height 22%. Drawn as an ellipse
    // and a rectangle that OVERLAP by that height: same fill, no seam, no curve
    // to get wrong.
    val gx = -0.02f * w
    val gyTop = 0.76f * h
    val gW = 1.04f * w
    val gH = 0.24f * h
    val ry = gH * 0.22f
    drawOval(Tokens.grass, topLeft = Offset(gx, gyTop), size = Size(gW, ry * 2f))
    drawRect(Tokens.grass, topLeft = Offset(gx, gyTop + ry), size = Size(gW, maxOf(0f, gH - ry)))
}

private data class Hump(val size: Float, val x: Float, val y: Float)

/**
 * A cloud: a soft white pill with two humps, no outline — scenery, not chrome.
 *
 * The humps are masked to their top 60% (`clip-path: inset(0 0 40% 0)`) so their
 * cut edge hides inside the pill's body and the whole reads as ONE shape.
 */
private fun DrawScope.cloud(
    x: Float, y: Float, w: Float, h: Float, rotation: Float, humps: List<Hump>,
) {
    rotate(rotation, Offset(x + w / 2f, y + h / 2f)) {
        val r = h / 2f
        drawRoundRect(Color.White, Offset(x, y), Size(w, h), CornerRadius(r, r))
        for (hump in humps) {
            val cx = x + hump.x + hump.size / 2f
            val cy = y + hump.y + hump.size / 2f
            clipRect(
                left = cx - hump.size, top = cy - hump.size / 2f,
                right = cx + hump.size, bottom = cy - hump.size / 2f + hump.size * 0.6f,
            ) {
                drawCircle(Color.White, hump.size / 2f, Offset(cx, cy))
            }
        }
    }
}
