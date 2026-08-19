package com.couchgames.tinytrackparty

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.unit.dp
import kotlin.math.min

/**
 * The full-screen warm-paper backdrop that boards sit on: `theme.css`'s `.scene`
 * — sky glow, two rolling hills, three sticker clouds, a flat grass band.
 * Decorative only; it never takes focus and never eats a remote press.
 *
 * **WHERE THIS MAY GO.** Paper backgrounds are for FULL-SCREEN BOARDS only — the
 * welcome title board, and the lobby before a track is picked. Chrome that floats
 * over the live 3D view floats BARE: no paper, no panel behind it. And nothing
 * inside the 3D scene is ever outlined or toon-shaded, which is the same rule
 * seen from the other side. Putting a [PaperStage] behind the race HUD would
 * break both at once.
 *
 * (There is no sun. It was yellow, and yellow is vetoed in chrome.)
 *
 * ONE CANVAS, unlike the tvOS version's nested views. Every element here is a
 * fill with no text, no focus and no hit testing, so a composed subtree per cloud
 * would buy nothing and cost a layout pass on a GPU that has none to spare.
 */
@Composable
fun PaperStage(modifier: Modifier = Modifier) {
    Canvas(modifier.fillMaxSize().background(Tokens.paper)) { backdrop() }
}

private fun DrawScope.backdrop() {
    val w = size.width
    val h = size.height

    // `radial-gradient(120% 90% at 50% -20%, #fffdf7 0%, transparent 55%)` — a
    // soft warm glow high in the sky that gives the paper some air.
    //
    // The far stop is the SAME colour at zero opacity, never Color.Transparent —
    // that is transparent BLACK, and interpolating toward it would drag a grey
    // bruise through the fade.
    //
    // The CSS shape is an ELLIPSE (120% of the width by 90% of the height); a
    // circle on a 16:9 stage is visibly a different glow, so the canvas is scaled
    // rather than the radius fudged.
    val glow = Color(0xFFFFFDF7)
    val centre = Offset(0.5f * w, -0.2f * h)
    val gw = 2.4f * w
    val gh = 1.8f * h
    val unit = min(gw, gh) / 2f
    withTransform({ scale(gw / min(gw, gh), gh / min(gw, gh), centre) }) {
        drawCircle(
            brush = Brush.radialGradient(
                0f to glow, 0.55f to glow.copy(alpha = 0f),
                center = centre, radius = unit,
            ),
            radius = unit,
            center = centre,
        )
    }

    // Rolling hills peeking over the grass band. These two greens are authored
    // inline in `theme.css`'s `.scene__sky::before/::after` rather than as
    // `:root` tokens, and the bake only carries `:root` — so they are hardcoded
    // here for the same reason they are hardcoded there: they are stage scenery,
    // not part of the design system.
    drawOval(
        Color(0xFFD3EDBB),
        topLeft = Offset(-0.16f * w, h - 0.11f * h - 0.30f * h),
        size = Size(0.74f * w, 0.30f * h),
    )
    drawOval(
        Color(0xFFE0F3CD),
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
    // density is 2.0 and unscaled clouds draw at HALF size while `3.dp.toPx()`
    // below correctly doubles, giving a half-size cloud with a double-weight
    // outline. Fractions of `w`/`h` are already resolution-free and take no `u`.
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
    //
    // No outline. Outlines belong to the stickers sitting on the stage, not to
    // the stage.
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
 * A sticker cloud: a white outlined pill with outlined circle humps.
 *
 * The humps are masked to their top 60% (`clip-path: inset(0 0 40% 0)`) so their
 * cut edge hides inside the pill's white body and the outline reads as ONE
 * die-cut shape. They are drawn ON TOP of the pill for that to work, which is the
 * CSS's own paint order (::before/::after over the parent).
 *
 * `#fff`, not `--surface`: the CSS scene rules write the literal, because a cloud
 * is scenery rather than a sticker surface and should not follow `--surface` if
 * that ever moves.
 */
private fun DrawScope.cloud(
    x: Float, y: Float, w: Float, h: Float, rotation: Float, humps: List<Hump>,
) {
    rotate(rotation, Offset(x + w / 2f, y + h / 2f)) {
        // Stage scenery deliberately runs LIGHTER than chrome: alpha 0.10 against
        // the kit's 0.18. It is backdrop, and a full-strength drop would make the
        // clouds compete with the cards in front of them.
        val drop = Tokens.ink.copy(alpha = 0.10f)
        val stroke = 3.dp.toPx()
        val off = 4.dp.toPx()
        val r = h / 2f
        drawRoundRect(drop, Offset(x + off, y + off), Size(w, h),
            androidx.compose.ui.geometry.CornerRadius(r, r))
        drawRoundRect(Color.White, Offset(x, y), Size(w, h),
            androidx.compose.ui.geometry.CornerRadius(r, r))
        drawRoundRect(Tokens.ink, Offset(x + stroke / 2f, y + stroke / 2f),
            Size(w - stroke, h - stroke),
            androidx.compose.ui.geometry.CornerRadius(r, r), style = Stroke(stroke))
        for (hump in humps) {
            val cx = x + hump.x + hump.size / 2f
            val cy = y + hump.y + hump.size / 2f
            clipRect(
                left = cx - hump.size, top = cy - hump.size / 2f,
                right = cx + hump.size, bottom = cy - hump.size / 2f + hump.size * 0.6f,
            ) {
                drawCircle(Color.White, hump.size / 2f, Offset(cx, cy))
                drawCircle(Tokens.ink, hump.size / 2f - stroke / 2f, Offset(cx, cy),
                    style = Stroke(stroke))
            }
        }
    }
}

