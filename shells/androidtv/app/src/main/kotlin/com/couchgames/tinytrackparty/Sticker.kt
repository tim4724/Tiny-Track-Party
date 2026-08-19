package com.couchgames.tinytrackparty

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The "Sticker Bash" component kit — `theme.css`'s `.card .btn .pill`, the
 * `.wordmark` badge and the `.scene` paper stage, as Compose.
 *
 * The language, from `theme.css`'s own header: die-cut STICKERS on the TV glass.
 * Flat saturated colour on warm paper, thick warm-ink outlines (`--ink` #2A2735,
 * **never** `#000`), hard UN-BLURRED offset shadows, everything slightly rotated
 * as if slapped on by hand. Chrome is red/green/blue/purple only; amber, pink,
 * orange and cyan are liveries ([Tokens.car]) and never chrome. Celebration is
 * RED.
 *
 * Build new screens out of these. Page code owns LAYOUT; this file owns colour,
 * type, surface and shadow — the same split the CSS keeps, and the reason the
 * web's screens stayed consistent for free.
 *
 * Every number below is in AUTHORED PIXELS, which under the root's
 * [LocalDensity] override is `dp`. See `shells/androidtv/CLAUDE.md`.
 */
object Sticker {

    /**
     * Border weight. `theme.css` says 3px; one heavier here because the same
     * picture is read from across a room rather than at arm's length, and because
     * a 3px line is the first thing a TV's edge sharpening eats.
     */
    val border: Dp = 4.dp

    /**
     * Thinner rule, for the small tokens the CSS draws at 2-2.5px (livery dots,
     * mini-map frames, the difficulty pips).
     */
    val hairlineBorder: Dp = 2.5.dp

    val radiusSmall: Dp get() = Tokens.radius("r-sm")
    val radius: Dp get() = Tokens.radius("r")
    val radiusLarge: Dp get() = Tokens.radius("r-lg")

    /** `--shadow-pop` — chips and small stickers. */
    val popShadow: Tokens.Shadow get() = Tokens.shadow("shadow-pop")

    /** `--shadow-card` — big sticker cards. */
    val cardShadow: Tokens.Shadow get() = Tokens.shadow("shadow-card")

    /** `--shadow-float` — an alias of the card drop, for chrome that floats over
     *  the scene rather than sitting on a board. */
    val floatShadow: Tokens.Shadow get() = Tokens.shadow("shadow-float")

    /**
     * Ledge geometry, and the one invariant behind it. `--btn-drop` is how far
     * the ink ledge sits below a button at rest; `--btn-sink` is how far the face
     * travels when pressed; the ledge you can still see while pressed is the
     * DIFFERENCE. That is why `--btn-sink` must stay under `--btn-drop` (travel
     * equal to the drop would punch the button through its own ledge and flatten
     * it) and why [Tokens] asserts it at load.
     */
    val buttonDrop: Dp get() = Tokens.length("btn-drop")
    val buttonSink: Dp get() = Tokens.length("btn-sink")

    /**
     * How the two web pointer states map onto a TV.
     *
     * A TV has no pointer, so `:hover` has no analogue and `:active` is not a
     * state the user can dwell in. What replaces both is the FOCUS system:
     * exactly one control on screen is focused, and the remote's centre click is
     * a momentary press on that one.
     *
     *   `:hover`  (`filter: brightness(1.04)`) → FOCUSED: brighten, lift by
     *             [focusScale], deepen the shadow.
     *   `:active` (`translateY(--btn-sink)`)   → PRESSED: unchanged, the ledge
     *             geometry ports as-is.
     *
     * The lift is the piece with no CSS ancestor. It exists because focus on a TV
     * has to be legible from the sofa, where a 4% brightness change is not.
     */
    const val focusScale = 1.06f
    const val focusBrightness = 0.04f
    val focusShadow = Tokens.Shadow(10.dp, 10.dp, 0.dp, Color.Unspecified)
}

// -- modifiers --------------------------------------------------------------

/**
 * The die-cut drop: a hard offset shadow with ZERO blur.
 *
 * The blur is what makes the difference. A blurred shadow reads as a card
 * floating above a surface; an unblurred one reads as a sticker cut out and stuck
 * down, which is the whole language. `theme.css` states the rule as "offset is
 * about 2x the border width, alpha always 0.18, so every sticker reads as stamped
 * by the same machine".
 *
 * NOT `Modifier.shadow()`, which is an ELEVATION shadow: it blurs, it tints
 * toward the ambient light model, and its spread is a function of elevation
 * rather than of an authored offset. There is no elevation in this design system.
 * This draws the shape again, offset, behind — which is exactly what CSS
 * `box-shadow` with a zero blur radius does.
 *
 * **Apply this to the SHAPE, not to a composed subtree.** It follows the shape it
 * is given, so handing it a card that already contains its label is fine here
 * (unlike SwiftUI, whose `.shadow` follows rendered alpha and embosses the text).
 */
fun Modifier.hardShadow(
    shadow: Tokens.Shadow,
    shape: Shape,
    color: Color = Tokens.shadowInk,
): Modifier = drawBehind {
    val c = if (shadow.color == Color.Unspecified) color else shadow.color
    val outline = shape.createOutline(size, layoutDirection, this)
    translate(shadow.x.toPx(), shadow.y.toPx()) { drawOutline(outline, c) }
}

/**
 * The thick warm-ink outline every sticker carries.
 *
 * `Modifier.border` insets by the stroke width so the outline sits INSIDE the
 * bounds. That is CSS's `box-sizing: border-box`, which the whole kit is authored
 * against — a centred stroke would grow every card by the border weight and pull
 * the chip rows out of alignment with the geometry C++ hands back.
 */
fun Modifier.stickerOutline(
    width: Dp = Sticker.border,
    shape: Shape,
    color: Color = Tokens.ink,
): Modifier = border(width, color, shape)

/**
 * `border: 4px dashed` — the empty item slot's reserved square.
 *
 * Compose's `Modifier.border` takes a solid brush and no dash pattern, and a solid
 * rule at this weight reads as a filled tile rather than as a space held open.
 * Drawn rather than approximated: the CSS says dashed and the difference is the
 * whole meaning of the shape.
 */
fun Modifier.dashedOutline(
    width: Dp,
    radius: Dp,
    color: Color,
    // DERIVED FROM THE STROKE, because that is what a browser does: Blink builds a
    // dashed border's rhythm out of its own width, roughly 2x on and 1x off. A
    // fixed 10/8 gave an 18 px period against the item slot's 12, which reads as a
    // coarse hand-drawn dash where the CSS is a fine machine-cut perforation — and
    // it was wrong by a different amount on the lobby's thinner seat rule.
    on: Dp = width * 2f,
    off: Dp = width,
): Modifier = drawBehind {
    val w = width.toPx()
    val r = radius.toPx()
    drawRoundRect(
        color = color,
        topLeft = androidx.compose.ui.geometry.Offset(w / 2f, w / 2f),
        size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(r, r),
        style = androidx.compose.ui.graphics.drawscope.Stroke(
            width = w,
            pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(
                floatArrayOf(on.toPx(), off.toPx())
            ),
        ),
    )
}

/** Slapped down by hand. */
fun Modifier.tilt(degrees: Float): Modifier =
    if (degrees == 0f) this else graphicsLayer { rotationZ = degrees }

// -- card -------------------------------------------------------------------

/**
 * `.card` — the sticker panel everything important sits on.
 *
 * `theme.css`'s `.card` carries no padding on purpose (the page owns layout), so
 * the default here is this shell's rather than the design system's.
 */
@Composable
fun StickerCard(
    modifier: Modifier = Modifier,
    rotation: Float = 0f,
    padding: Dp = 28.dp,
    /** Several cards are padded ASYMMETRICALLY in the CSS (`.cell-finish` is
     *  20.8 x 35.2 authored px), and a uniform box hugs their content. */
    horizontalPadding: Dp = padding,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(Sticker.radiusLarge)
    Box(
        modifier
            // The tilt is applied FIRST in the chain so it wraps everything after
            // it, which puts the shadow inside the rotation — slapped down by
            // hand, shadow and all, rather than a tilted card over a square drop.
            .tilt(rotation)
            .hardShadow(Sticker.cardShadow, shape)
            .background(Tokens.surface, shape)
            .stickerOutline(Sticker.border, shape)
            .padding(vertical = padding, horizontal = horizontalPadding),
        contentAlignment = Alignment.Center,
    ) { content() }
}

// -- button -----------------------------------------------------------------

/**
 * `.btn` — the chunky sticker push-button, driven by the focus system.
 *
 * @param size default 34, which is what the welcome board's CTA resolves to on a
 *   1920-wide web display (`clamp(22px, 2.6vw, 34px)`).
 * @param ghost `.btn--ghost` — the QUIET secondary action. A WHITE face with ink
 *   type, keeping the same ledge DEPTH as a primary so the two sit level; only
 *   the ledge's colour goes translucent (`rgba(42, 39, 53, 0.35)` rather than the
 *   solid token).
 *
 *   It exists because the substitute was visibly not it. The tvOS pause card's
 *   second button was drawn as an INK-FILLED primary — the darkest value in the
 *   palette, beside a green Continue — so the quiet option read as the loud one.
 *   A quiet action drawn in the heaviest ink available is not a quieter button,
 *   it is a different button.
 */
@Composable
fun StickerButton(
    title: String,
    modifier: Modifier = Modifier,
    tint: Color = Tokens.brand,
    size: Dp = 34.dp,
    ghost: Boolean = false,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    var hasFocus by remember { mutableStateOf(false) }

    // 0.06s is the kit's own transition; focus gets a touch longer so the lift
    // reads as movement rather than a jump.
    val scale by animateFloatAsState(
        if (hasFocus) Sticker.focusScale else 1f,
        tween(120), label = "btnScale",
    )

    val shape = RoundedCornerShape(Sticker.radius)
    val face = if (ghost) Tokens.surface else tint
    val drop = Sticker.buttonDrop
    val sink = if (pressed) Sticker.buttonSink else 0.dp

    Box(
        modifier
            .graphicsLayer { scaleX = scale; scaleY = scale }
            // Reserve the ledge, which nothing below takes part in layout for.
            .padding(bottom = drop),
        // PROPAGATED, so a caller's `defaultMinSize` reaches the FACE. A Box does
        // not pass its minimum constraints down by default and aligns TopStart,
        // so a `minWidth` handed in through `modifier` inflated this wrapper and
        // left the visible pill at its natural width with the surplus as dead
        // space beside it — a pair of buttons meant to be a matched set came out
        // unequal and pushed off their card's centre.
        propagateMinConstraints = true,
    ) {
        Box(
            Modifier
                // Pressed, the FACE travels down by --btn-sink and the ledge
                // stays put, so what is still visible is (drop - sink). Drawing
                // the ledge relative to the face means subtracting the travel
                // here — which is exactly the shrinking box-shadow the CSS
                // draws, and needs no second box to keep in sync with this one's
                // size.
                //
                // A GHOST's ledge is the ink at 35%, not the solid token: a white
                // face over a full-strength ledge reads as a white card sitting
                // on a black bar. Same DEPTH, lighter ink.
                //
                // TRANSLATED, not padded. `padding(top = sink)` grows the pressed
                // button's MEASURED height by --btn-sink and pushes its siblings
                // down — pressing Continue nudged the pause overlay's ghost button.
                // CSS translateY costs no layout, and neither does this.
                .graphicsLayer { translationY = sink.toPx() }
                .hardShadow(
                    Tokens.Shadow(0.dp, drop - sink, 0.dp, Color.Unspecified), shape,
                    color = if (ghost) Tokens.ink.copy(alpha = 0.35f) else Tokens.btnLedge,
                )
                .then(if (hasFocus) Modifier.hardShadow(Sticker.focusShadow, shape) else Modifier)
                .background(face.lifted(if (hasFocus) Sticker.focusBrightness else 0f), shape)
                .stickerOutline(Sticker.border, shape)
                .onFocusChanged { hasFocus = it.isFocused }
                .clickable(interactionSource = interaction, indication = null, onClick = onClick)
                // `.btn`'s padding is 0.8em 1.2em — em-relative, so it scales
                // with whatever size the caller picked.
                .padding(vertical = size * 0.8f, horizontal = size * 1.2f),
            contentAlignment = Alignment.Center,
        ) {
            StickerText(
                title,
                size = size,
                weight = Fonts.bold,
                color = if (ghost) Tokens.ink else Color.White,
            )
        }
    }
}

/**
 * `filter: brightness(1 + amount)` on a flat fill.
 *
 * CSS brightness MULTIPLIES; this lerps toward white instead, because a
 * multiply on an already-bright sticker face (the green CTA is 0.78 luminance)
 * moves it barely at all, and the point of the focus lift is that it is visible
 * from a sofa. Same gesture, comparable strength — the same trade `RaceHUDView`
 * makes for the item slot's roulette strobe.
 */
private fun Color.lifted(amount: Float): Color =
    if (amount == 0f) this else Color(
        red + (1f - red) * amount,
        green + (1f - green) * amount,
        blue + (1f - blue) * amount,
        alpha,
    )

// -- pill -------------------------------------------------------------------

/**
 * `.pill` — an ink label sticker: white uppercase caps on a solid pill.
 *
 * The uppercasing is `text-transform: uppercase` in the CSS, i.e. a look decision
 * applied at render, not something baked into the data. It is done here for the
 * same reason: [Copy.races] answers "1 race" and both screens should be able to
 * spell it either way.
 *
 * @param size default 18. The web pill is 0.7-0.78rem (~12px) — the one place a
 *   straight transfer would be genuinely unreadable across a room, so this is the
 *   kit's largest deliberate departure from the CSS.
 */
@Composable
fun StickerPill(
    text: String,
    modifier: Modifier = Modifier,
    tint: Color = Tokens.ink,
    size: Dp = 18.dp,
    /** `letter-spacing`, which the CSS varies per pill: `.pill` is 0.1em, the LAP
     *  readout 0.12em, the FINISHED badge 0.16em. Hard-coded at one value it was
     *  right for exactly one of the three. */
    tracking: Float = 0.1f,
) {
    Box(
        modifier
            .background(tint, RoundedCornerShape(percent = 50))
            .padding(vertical = size * 0.32f, horizontal = size * 0.95f)
    ) {
        StickerText(
            text.uppercase(),
            size = size,
            weight = Fonts.semibold,
            color = Color.White,
            tracking = tracking,
        )
    }
}

/**
 * `.cup-races` — the OUTLINED pill: ink caps on white paper, ink rule, hard drop.
 *
 * A separate composable rather than a flag on [StickerPill], because it is a
 * different token in the CSS as well: `.pill` is an INK LABEL (white type on a
 * solid fill, no border, no shadow) and `.cup-races` is a quiet CAPTION (surface
 * face, 2.5px ink border, `--shadow-pop`). Drawing the caption as a filled pill —
 * which is what the race card did, in blue — turns the card's footnote into its
 * loudest chrome and puts a fifth colour on a board that has four.
 */
@Composable
fun StickerPillOutlined(
    text: String,
    modifier: Modifier = Modifier,
    size: Dp = 18.dp,
) {
    val pill = RoundedCornerShape(percent = 50)
    Box(
        modifier
            .hardShadow(Sticker.popShadow, pill)
            .background(Tokens.surface, pill)
            .stickerOutline(Sticker.hairlineBorder, pill)
            .padding(vertical = size * 0.3f, horizontal = size * 0.95f)
    ) {
        StickerText(
            text.uppercase(),
            size = size,
            weight = Fonts.semibold,
            color = Tokens.ink,
            tracking = 0.1f,   // letter-spacing: 0.1em
        )
    }
}

// -- badge ------------------------------------------------------------------

/**
 * `.cup-sticker` — the die-cut NAME badge: white display caps on a solid colour
 * face, thick ink rule, hard drop, slapped down at an angle.
 *
 * It is the loudest thing on the card it tops, and that is the point: the race
 * card exists to say WHICH circuit, and drawing that name as plain ink text made
 * the card's headline quieter than its own footnote.
 *
 * Not a [StickerPill]: a pill is a small label token with pill-radius corners and
 * no border, and this is a card-scale badge with `--r` corners and the full ink
 * rule. They read as different objects because they are.
 */
@Composable
fun StickerBadge(
    text: String,
    modifier: Modifier = Modifier,
    tint: Color = Tokens.red,
    size: Dp = 27.dp,
    rotation: Float = -2f,
) {
    val shape = RoundedCornerShape(Sticker.radius)
    Box(
        modifier
            .tilt(rotation)
            .hardShadow(Sticker.cardShadow, shape)
            .background(tint, shape)
            .stickerOutline(Sticker.border, shape)
            // `.cup-sticker`'s padding is 0.45em 0.75em — em-relative, so it tracks
            // whatever size the caller picked.
            .padding(vertical = size * 0.45f, horizontal = size * 0.75f),
    ) {
        StickerText(text, size = size, weight = Fonts.bold, color = Color.White, lineHeight = 1.05f)
    }
}

// -- progression marks ------------------------------------------------------

/**
 * `.starrow` — the cup reward arc, as die-cut stars.
 *
 * RED, and that is a rule rather than a palette choice: gold and amber are vetoed
 * in chrome, and celebration is red. An unearned star is white at 35%, so the row
 * always shows how many there are to win.
 *
 * Drawn rather than typed, exactly as `starRow` in `shared/trackPicker.js` is: no
 * star codepoint has a consistent shape or weight across fallback fonts, and this
 * one has to sit beside a 2.5 dp ink rule and match it.
 */
@Composable
fun StarRow(filled: Int, modifier: Modifier = Modifier, size: Dp = 21.dp, max: Int = 3) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(size * 0.14f)) {
        for (i in 0 until max) Star(size, on = i < filled)
    }
}

@Composable
private fun Star(size: Dp, on: Boolean) {
    // `.star--off path { fill: #fff; opacity: 0.35 }` — the opacity is on the PATH,
    // so it fades the ink stroke along with the white fill. Drawing the outline only
    // when the star is earned leaves an unearned one white-on-white, i.e. invisible:
    // the row then shows how many stars you HAVE and never how many there are.
    val alpha = if (on) 1f else 0.35f
    val fill = if (on) Tokens.red else Color.White
    val ink = Tokens.ink
    androidx.compose.foundation.Canvas(Modifier.size(size).alpha(alpha)) {
        // `starRow`'s own path, in its 0 0 24 24 box.
        val p = androidx.core.graphics.PathParser.createPathFromPathData(
            "M12 2.6l2.8 5.9 6.3.8-4.6 4.4 1.2 6.3L12 17l-5.7 3 1.2-6.3L2.9 9.3l6.3-.8z"
        ).asComposePath()
        drawContext.transform.scale(this.size.minDimension / 24f, this.size.minDimension / 24f,
            androidx.compose.ui.geometry.Offset.Zero)
        drawPath(p, fill)
        drawPath(p, ink, style = androidx.compose.ui.graphics.drawscope.Stroke(
            width = 2.4f, join = androidx.compose.ui.graphics.StrokeJoin.Round))
    }
}

/**
 * `lockGlyph` — the drawn padlock.
 *
 * NOT the emoji. `shared/trackPicker.js` says why in one line: "platform lock
 * glyphs are coloured and clash with the sticker ink". A 🔒 on Android is a full
 * colour bitmap with its own gold body, which is both an unvetted colour and the
 * one hue this palette forbids.
 */
@Composable
fun LockGlyph(modifier: Modifier = Modifier, size: Dp = 21.dp, color: Color = Tokens.ink) {
    androidx.compose.foundation.Canvas(modifier.size(size)) {
        val s = this.size.minDimension / 24f
        drawContext.transform.scale(s, s, androidx.compose.ui.geometry.Offset.Zero)
        val shackle = androidx.core.graphics.PathParser
            .createPathFromPathData("M7 11V8a5 5 0 0 1 10 0v3").asComposePath()
        drawPath(shackle, color, style = androidx.compose.ui.graphics.drawscope.Stroke(
            width = 2.6f, cap = androidx.compose.ui.graphics.StrokeCap.Round))
        drawRoundRect(
            color,
            topLeft = androidx.compose.ui.geometry.Offset(5f, 10.5f),
            size = androidx.compose.ui.geometry.Size(14f, 10.5f),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.6f, 2.6f),
        )
    }
}

// -- text -------------------------------------------------------------------

/**
 * Display type, in authored pixels.
 *
 * `sp` rather than `dp`, and that is safe here rather than an accessibility
 * mistake: the root pins `fontScale = 1f` in its density override, so `sp` and
 * `dp` are the same unit under it. The reason for the pin is in
 * `shells/androidtv/CLAUDE.md` — a HUD anchored to engine-supplied cell rects
 * must not reflow under a system font-size setting.
 */
@Composable
fun StickerText(
    text: String,
    modifier: Modifier = Modifier,
    size: Dp = 26.dp,
    weight: FontWeight = Fonts.bold,
    color: Color = Tokens.ink,
    tracking: Float = 0f,
    body: Boolean = false,
    maxLines: Int = 1,
    /** `text-align: center` — for the few places a value WRAPS and its second line
     *  would otherwise hang left under a centred first one. */
    center: Boolean = false,
    /**
     * CSS `line-height`, as a multiple of the type size. Null takes the font's
     * own metrics, which is what almost everything wants; the wordmark and the
     * countdown pass a sub-1.0 value, where the glyphs deliberately overhang
     * their box exactly as they do in the CSS.
     */
    lineHeight: Float? = null,
) {
    androidx.compose.foundation.text.BasicText(
        text = text,
        modifier = modifier,
        style = TextStyle(
            color = color,
            fontSize = size.value.sp,
            fontFamily = if (body) Fonts.body else Fonts.display,
            fontWeight = weight,
            letterSpacing = (size.value * tracking).sp,
            lineHeight = if (lineHeight == null) TextUnit.Unspecified
                else (size.value * lineHeight).sp,
            // WITHOUT THESE, a sub-1.0 line-height does nothing visible. Compose
            // adds the font's ascent/descent padding to the first and last line
            // by default (a legacy TextView behaviour), and its default
            // lineHeightStyle only distributes leading BETWEEN lines — so a tight
            // lockup keeps the gap the CSS removes. Trimming both is what makes
            // `line-height: 0.98` mean the same thing here as in the browser.
            textAlign = if (center) androidx.compose.ui.text.style.TextAlign.Center
                else androidx.compose.ui.text.style.TextAlign.Unspecified,
            platformStyle = PlatformTextStyle(includeFontPadding = false),
            lineHeightStyle = LineHeightStyle(
                alignment = LineHeightStyle.Alignment.Center,
                trim = LineHeightStyle.Trim.Both,
            ),
        ),
        maxLines = maxLines,
        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
    )
}

// -- wordmark ---------------------------------------------------------------

/**
 * The ONE die-cut badge: "TINY TRACK" over "PARTY!". Never a row of pills, never
 * plain text.
 *
 * The white edge is `-webkit-text-stroke: 7px #fff` with `paint-order: stroke
 * fill` in the CSS, and Compose has no text stroke either. It is drawn here as
 * offset white copies behind the fill, which is the only primitive available.
 * That is more layers than it sounds like, but this is static chrome on two
 * boards and never on the race path — and the CSS itself already declares a
 * graceful degradation ("without paint-order support it degrades to plain ink
 * text — acceptable"), so `dieCut = false` is a supported look, not a fallback.
 * The lobby ticket's masthead uses it: a white edge on a white card is invisible,
 * so `.ticket__wordmark` zeroes the stroke.
 *
 * @param size default 130, the poster scale a 1920-wide web display clamps
 *   `.welcome__wordmark` to. The lobby ticket's masthead is 38.
 */
@Composable
fun Wordmark(
    modifier: Modifier = Modifier,
    size: Dp = 130.dp,
    dieCut: Boolean = true,
) {
    /*
     * How far the white cut reaches OUTSIDE the glyphs.
     *
     * The CSS pins the stroke at 7px against a font-size that clamps between 56
     * and 130, so on the web the edge is proportionally heavier on a small
     * window. A TV has exactly one size, so the faithful reading at poster scale
     * is 7/130 of the type size — HALVED, because a text stroke is centred on the
     * outline and only half of it shows, while these stamps dilate the glyph by
     * their full offset.
     */
    val edge = size * 0.055f / 2f
    val samples = 16

    Box(
        modifier
            // Shadow BEFORE the rotation, so it tilts with the badge. CSS applies
            // `filter` in the element's own space and `transform` after it, so
            // the web's drop-shadow is rotated too.
            .tilt(-2f),
        contentAlignment = Alignment.Center,
    ) {
        if (dieCut) {
            for (i in 0 until samples) {
                val a = i.toDouble() / samples * 2 * Math.PI
                Lockup(
                    size,
                    top = Color.White, bottom = Color.White,
                    modifier = Modifier.graphicsLayer {
                        translationX = (Math.cos(a) * edge.toPx()).toFloat()
                        translationY = (Math.sin(a) * edge.toPx()).toFloat()
                    },
                )
            }
        }
        Lockup(size, top = Tokens.ink, bottom = Tokens.red)
    }
}

@Composable
private fun Lockup(size: Dp, top: Color, bottom: Color, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        StickerText(Copy.wordmarkLine1, size = size, color = top, tracking = 0.01f,
            lineHeight = 0.98f)
        // `.wordmark .l2 { font-size: 1.24em }` — PARTY! is the louder half.
        StickerText(Copy.wordmarkLine2, size = size * 1.24f, color = bottom, tracking = 0.01f,
            lineHeight = 0.98f)
    }
}
