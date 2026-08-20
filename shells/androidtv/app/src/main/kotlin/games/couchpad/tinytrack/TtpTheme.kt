package games.couchpad.tinytrack

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp

/**
 * The AUTHORED PIXEL SPACE, which is the single most load-bearing decision in
 * this shell's UI.
 *
 * tvOS is always 1920x1080 **points**, whatever the box outputs, so a design
 * token's px value transfers with no conversion at all and the Swift writes
 * `152` literally. Android is not: a 1080p TV reports 1920x1080 px at density
 * 2.0, so Compose sees **960x540 dp**, and `152.dp` would draw at double size.
 *
 * Rather than convert at four hundred call sites — and forget one — this
 * provider redefines the unit. Under it `density = windowWidthPx / 1920f`, so
 * **one `dp` is one authored pixel**: the same number `theme.css` writes, the
 * same number the tvOS Swift writes as a point. Every size in [Sticker],
 * [Tokens] and every screen is then the web's own number, and porting a
 * SwiftUI view is transcription rather than arithmetic.
 *
 * It also holds on hardware that is not 1920 wide. Android TV's convention puts
 * essentially every box at 960x540 dp (1080p at 320dpi, 4K at 640dpi, 720p at
 * 213dpi all land there), but the ratio is computed rather than assumed, so a
 * box that reports something else still gets a token at the same FRACTION of the
 * screen.
 *
 * ## fontScale is pinned to 1
 *
 * Android exposes a system font-size setting that a TV rarely surfaces but does
 * honour. The race HUD is anchored to cell rectangles the RENDERER computed in
 * C++ (`ttp_display_cell_rects`), so type that grew under an accessibility
 * setting would drift off geometry this shell does not own — a name chip
 * spilling into the next player's picture. `Fonts.swift` pins the same thing for
 * the same reason (`fixedSize:` rather than `size:`).
 *
 * ## Two rules for anything under this provider
 *
 * - **Never read `LocalConfiguration.screenWidthDp` below here.** It still
 *   answers the real 960, not the virtual 1920, and mixing the two spaces is the
 *   one way this arrangement goes quietly wrong.
 * - **Engine rectangles need the OTHER conversion** — [toAuthored] —
 *   because `ttp_display_cell_rects` answers in the SURFACE's physical pixels,
 *   and the surface is not the window: the adaptive render scale resizes the
 *   buffer underneath while the view keeps its bounds.
 */
@Composable
fun TtpTheme(windowWidthPx: Int, content: @Composable () -> Unit) {
    val density = Density(
        density = if (windowWidthPx > 0) windowWidthPx / AUTHORED_WIDTH else 1f,
        fontScale = 1f,
    )
    CompositionLocalProvider(LocalDensity provides density, content = content)
}

/**
 * The viewport `theme.css` and the tvOS shell are both authored against. Not a
 * resolution: a coordinate space.
 */
const val AUTHORED_WIDTH = 1920f

/**
 * The other axis of that same space. Only the cell rects need it — everything
 * else this tree lays out is width-relative under the density override — but a
 * rect's y and h are fractions of the surface's HEIGHT and 16:9 is not a thing
 * to re-derive at the one call site.
 */
const val AUTHORED_HEIGHT = 1080f

/**
 * A cell rectangle as the ABI answers it — FRACTIONS of the surface — scaled to
 * the authored canvas this tree lays out in.
 *
 * NOTHING ABOUT THE BUFFER IS NEEDED, which is the point. The rects used to come
 * back in surface pixels and be divided by the buffer width, and that width
 * reached Compose as a plain field through a `staticCompositionLocalOf` —
 * invisible to it. On a scale move the rects updated and the width did not, and
 * a 1920-wide layout landed at half size in a corner until something unrelated
 * recomposed. There is no second value here to go stale.
 */
fun CellRect.toAuthored(): CellRect = CellRect(
    x * AUTHORED_WIDTH, y * AUTHORED_HEIGHT, w * AUTHORED_WIDTH, h * AUTHORED_HEIGHT,
)
