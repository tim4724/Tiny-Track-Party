package games.paperballoon.tinytrack

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The "Toy Box" component kit — `theme.css`'s `.card .btn .pill` and the
 * `.wordmark` lockup, as Compose.
 *
 * The language is `theme.css`'s header, SIX ROLES that each mean the same thing
 * on the phone and the TV: PAPER is a white card you read; FROST is a
 * full-screen layer (the boards draw it, there is no kit piece for it); an
 * ACTION is the one solid colour button on a screen; a CHOICE is anything else
 * you press, white with a faint edge; a LABEL is a tinted pill, never a solid
 * fill; GLASS is a dark readout over the live 3D view and never pressed.
 * Everything is flat: no outline, no drop, no ledge. Chrome is
 * red/green/blue/purple only; amber, pink, orange and cyan are liveries
 * ([Tokens.car]). Celebration is RED.
 *
 * Build new screens out of these. Page code owns LAYOUT; this file owns colour,
 * type and surface — the same split the CSS keeps.
 *
 * Every number below is in AUTHORED PIXELS, which under the root's
 * [LocalDensity] override is `dp`. See `shells/androidtv/CLAUDE.md`.
 */
object Sticker {

    val radiusSmall: Dp get() = Tokens.radius("r-sm")
    val radius: Dp get() = Tokens.radius("r")
    val radiusLarge: Dp get() = Tokens.radius("r-lg")

    /** A choice's faint edge: `box-shadow: inset 0 0 0 2px var(--edge)`. */
    val edgeWidth: Dp = 2.dp

    /**
     * `--focus-ring`'s width. The token is a raw `3px solid var(--blue)`, which
     * the bake carries as a string; the colour is read as [Tokens.blue].
     *
     * FOCUS IS THE TV'S ONLY POINTER. The web shows this ring on `:focus-visible`
     * alone; here exactly one control on screen is always focused, so the ring is
     * what tells the room where the remote is.
     */
    val focusRingWidth: Dp = 3.dp

    /**
     * FROST WITHOUT THE BLUR, and so a little thicker than the token.
     *
     * The web's frost is `--frost` over `blur(var(--frost-r))`: the blur turns the
     * frozen race into soft colour and the 0.88 wash lightens it. Neither half of
     * the blur is reachable here — the race is the SurfaceView, composited below
     * this window where nothing in the view tree can sample it — and the user
     * decided this box gets no blur in any form. At the token's 0.88 the sharp
     * race, HUD chips and all, read through as a busy ghost behind the board, so
     * the same paper colour is laid at 0.94 instead: still the screen behind,
     * lightened, which is what frost means.
     */
    val frost: Color get() = Tokens.frost.copy(alpha = 0.94f)
}

// -- colour -------------------------------------------------------------------

/** `color-mix(in srgb, this pct%, with)`. */
fun Color.mix(pct: Float, with: Color): Color = Color(
    red * pct + with.red * (1f - pct),
    green * pct + with.green * (1f - pct),
    blue * pct + with.blue * (1f - pct),
    alpha * pct + with.alpha * (1f - pct),
)

/**
 * The LABEL recipe (`.pill`): the colour mixed 20% into white for the face and
 * 78% into a deep ink for the type. `#1B1830` is a literal in `theme.css`, not a
 * token, and it is spelled here for the same reason: it belongs to the recipe,
 * not to the palette.
 */
fun labelFace(c: Color): Color = c.mix(0.20f, Color.White)
fun labelInk(c: Color): Color = c.mix(0.78f, Color(0xFF1B1830))

/**
 * A livery as TYPE on white (`color-mix(in srgb, var(--c) 80%, var(--ink))`): a
 * pale livery stays legible on paper. The seat names and the board's names wear
 * it.
 */
fun liveryInk(index: Int): Color = Tokens.car(index).mix(0.80f, Tokens.ink)

// -- modifiers ----------------------------------------------------------------

/**
 * `--focus-ring` drawn [gap] OUTSIDE the shape (`outline-offset`), so it rings
 * the control rather than eating into its face. Drawn behind, past the bounds:
 * nothing in the kit clips, so it shows.
 */
fun Modifier.focusRing(on: Boolean, radius: Dp, gap: Dp = 4.dp): Modifier =
    if (!on) this else drawBehind {
        val w = Sticker.focusRingWidth.toPx()
        val g = gap.toPx()
        val r = radius.toPx() + g + w / 2f
        drawRoundRect(
            Tokens.blue,
            topLeft = Offset(-g - w / 2f, -g - w / 2f),
            size = Size(size.width + 2 * g + w, size.height + 2 * g + w),
            cornerRadius = CornerRadius(r, r),
            style = Stroke(w),
        )
    }

/**
 * `border: 3px dashed` — the empty item slot's reserved square.
 *
 * Compose's `Modifier.border` takes a solid brush and no dash pattern, and a
 * solid rule reads as a filled tile rather than as a space held open.
 */
fun Modifier.dashedOutline(
    width: Dp,
    radius: Dp,
    color: Color,
    // DERIVED FROM THE STROKE, because that is what a browser does: Blink builds a
    // dashed border's rhythm out of its own width, roughly 2x on and 1x off.
    on: Dp = width * 2f,
    off: Dp = width,
): Modifier = drawBehind {
    val w = width.toPx()
    val r = radius.toPx()
    drawRoundRect(
        color = color,
        topLeft = Offset(w / 2f, w / 2f),
        size = Size(size.width - w, size.height - w),
        cornerRadius = CornerRadius(r, r),
        style = Stroke(
            width = w,
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(on.toPx(), off.toPx())),
        ),
    )
}

/**
 * CSS `line-height: 1` on ONE line of type: a layout box exactly [height] tall,
 * the glyphs centred in it and overhanging it, as the browser's do. A one-line
 * [StickerText] keeps the face's own ~1.2em whatever its `lineHeight` says, so
 * a chip padded to the CSS's numbers stood several px taller than the web's.
 */
fun Modifier.lineBox(height: Dp): Modifier =
    this.height(height).wrapContentHeight(unbounded = true)

/** A fixed lean, for the few things that keep one (the countdown disc, the
 *  champs label, the wordmark's PARTY!). */
fun Modifier.tilt(degrees: Float): Modifier =
    if (degrees == 0f) this else graphicsLayer { rotationZ = degrees }

// -- paper ----------------------------------------------------------------------

/**
 * `.card` — PAPER: the white panel everything you read sits on. Flat, no
 * outline, no drop.
 *
 * `theme.css`'s `.card` carries no padding on purpose (the page owns layout), so
 * the default here is this shell's rather than the design system's.
 */
@Composable
fun PaperCard(
    modifier: Modifier = Modifier,
    padding: Dp = 28.dp,
    /** Several cards are padded ASYMMETRICALLY in the CSS (`.cell-finish` is
     *  20.8 x 35.2 authored px), and a uniform box hugs their content. */
    horizontalPadding: Dp = padding,
    content: @Composable () -> Unit,
) {
    Box(
        modifier
            .background(Tokens.surface, RoundedCornerShape(Sticker.radiusLarge))
            .padding(vertical = padding, horizontal = horizontalPadding),
        contentAlignment = Alignment.Center,
    ) { content() }
}

// -- button -------------------------------------------------------------------

/**
 * `.btn` — an ACTION: a solid colour face, white type, flat. Or, with [choice],
 * `.btn--ghost`: a CHOICE, white with the faint edge and ink type.
 *
 * A TV has no pointer, so `:hover` has no analogue and `:active` is a momentary
 * press of the remote's centre key. FOCUSED is the state a viewer dwells in, and
 * it is `:focus-visible`'s ring ([focusRing]); a choice is also washed in
 * `--pick`, the TV's blue. PRESSED darkens an action (`brightness(0.9)`) and
 * washes a choice in `--press`. Nothing scales or moves: a transform here would
 * animate a layer over the live race for nothing a viewer needs.
 *
 * @param size default 34, which is what the welcome board's CTA resolves to on a
 *   1920-wide web display (`clamp(22px, 2.6vw, 34px)`).
 */
@Composable
fun ActionButton(
    title: String,
    modifier: Modifier = Modifier,
    tint: Color = Tokens.brand,
    size: Dp = 34.dp,
    choice: Boolean = false,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    var hasFocus by remember { mutableStateOf(false) }

    val shape = RoundedCornerShape(Sticker.radius)
    val face = when {
        choice && pressed -> Tokens.press
        choice && hasFocus -> Tokens.pick
        choice -> Tokens.surface
        pressed -> tint.mix(0.9f, Color.Black)
        else -> tint
    }
    Box(
        modifier
            .focusRing(hasFocus, Sticker.radius)
            .background(face, shape)
            .then(if (choice) Modifier.border(Sticker.edgeWidth, Tokens.edge, shape) else Modifier)
            .onFocusChanged { hasFocus = it.isFocused }
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            // `.btn`'s padding is 0.85em 1.25em — em-relative, so it scales with
            // whatever size the caller picked.
            .padding(vertical = size * 0.85f, horizontal = size * 1.25f),
        // PROPAGATED, so a caller's `defaultMinSize` reaches the face: a Box does
        // not pass its minimum constraints down by default, and a pair meant to
        // be a matched set came out unequal.
        propagateMinConstraints = true,
        contentAlignment = Alignment.Center,
    ) {
        Box(contentAlignment = Alignment.Center) {
            StickerText(
                title,
                size = size,
                weight = Fonts.semibold,
                color = if (choice) Tokens.ink else Color.White,
                lineHeight = 1.1f,
            )
        }
    }
}

// -- label --------------------------------------------------------------------

/**
 * `.pill` — a LABEL: uppercase caps in a colour on a pale tint of it. Never a
 * solid fill, so it never reads as something to press.
 *
 * The uppercasing is `text-transform: uppercase` in the CSS, i.e. a look decision
 * applied at render, not something baked into the data.
 *
 * [face] and [ink] default to the recipe ([labelFace], [labelInk]); the two
 * labels the CSS spells by hand (`.cup-races`, the CPU tag) pass their own.
 *
 * @param size default 18. The web pill is 0.7rem (~11px) — the one place a
 *   straight transfer would be genuinely unreadable across a room, so this is the
 *   kit's largest deliberate departure from the CSS.
 */
@Composable
fun LabelPill(
    text: String,
    modifier: Modifier = Modifier,
    tint: Color = Tokens.ink2,
    size: Dp = 18.dp,
    /** `letter-spacing`, which the CSS varies per pill: `.pill` is 0.1em, the
     *  FINISHED badge 0.16em. */
    tracking: Float = 0.1f,
    face: Color = labelFace(tint),
    ink: Color = labelInk(tint),
) {
    Box(
        modifier
            .background(face, RoundedCornerShape(percent = 50))
            .padding(vertical = size * 0.35f, horizontal = size * 0.95f)
    ) {
        StickerText(text.uppercase(), size = size, weight = Fonts.bold, color = ink,
            tracking = tracking)
    }
}

// -- progression marks ----------------------------------------------------------

/**
 * `.starrow` — the cup reward arc.
 *
 * RED, and that is a rule rather than a palette choice: gold and amber are vetoed
 * in chrome, and celebration is red. An earned star is filled and stroked in its
 * own red with round joins, which is what rounds its points off; an unearned one
 * is HOLLOW, a see-through ink outline, so the row always shows how many there
 * are to win (a faint fill sank into a washed tile, a line does not).
 *
 * Drawn rather than typed, exactly as `starRow` in `shared/trackPicker.js` is: no
 * star codepoint has a consistent shape or weight across fallback fonts.
 */
@Composable
fun StarRow(filled: Int, modifier: Modifier = Modifier, size: Dp = 21.dp, max: Int = 3) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(size * 0.14f)) {
        for (i in 0 until max) Star(size, on = i < filled)
    }
}

@Composable
private fun Star(size: Dp, on: Boolean) {
    val red = Tokens.red
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        // `starRow`'s own path, in its 0 0 24 24 box.
        val p = androidx.core.graphics.PathParser.createPathFromPathData(
            "M12 2.6l2.8 5.9 6.3.8-4.6 4.4 1.2 6.3L12 17l-5.7 3 1.2-6.3L2.9 9.3l6.3-.8z"
        ).asComposePath()
        drawContext.transform.scale(this.size.minDimension / 24f, this.size.minDimension / 24f,
            Offset.Zero)
        if (on) {
            drawPath(p, red)
            drawPath(p, red, style = Stroke(width = 3.2f, join = StrokeJoin.Round))
        } else {
            // `.star--off path { stroke: rgba(38, 40, 56, 0.42) }`, a literal there too.
            drawPath(p, Color(38, 40, 56).copy(alpha = 0.42f),
                style = Stroke(width = 2.2f, join = StrokeJoin.Round))
        }
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
        drawContext.transform.scale(s, s, Offset.Zero)
        val shackle = androidx.core.graphics.PathParser
            .createPathFromPathData("M7 11V8a5 5 0 0 1 10 0v3").asComposePath()
        drawPath(shackle, color, style = Stroke(width = 2.6f, cap = StrokeCap.Round))
        drawRoundRect(
            color,
            topLeft = Offset(5f, 10.5f),
            size = Size(14f, 10.5f),
            cornerRadius = CornerRadius(2.6f, 2.6f),
        )
    }
}

// -- text -----------------------------------------------------------------------

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
     * own metrics, which is what almost everything wants; the wordmark passes a
     * sub-1.0 value, where the glyphs deliberately overhang their box exactly as
     * they do in the CSS.
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

// -- wordmark -------------------------------------------------------------------

/**
 * The ONE lockup: "TINY TRACK" in ink over a red "PARTY!" tipped against it
 * (`.wordmark .l2 { rotate: -3deg }`). Never a row of pills, never plain text.
 *
 * No white die-cut edge any more: the Toy Box draws the lockup flat everywhere a
 * board draws it. (The baked brand stills still carry the cut;
 * `scripts/bake-wordmark.mjs` owns those.)
 *
 * @param size the CSS font-size; the lobby ticket's masthead is 38.
 */
@Composable
fun Wordmark(modifier: Modifier = Modifier, size: Dp = 130.dp) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        StickerText(Copy.wordmarkLine1, size = size, color = Tokens.ink, tracking = 0.01f,
            lineHeight = 0.98f)
        // `.wordmark .l2 { font-size: 1.24em }` — PARTY! is the louder half.
        StickerText(Copy.wordmarkLine2, size = size * 1.24f, color = Tokens.red,
            tracking = 0.01f, lineHeight = 0.98f, modifier = Modifier.tilt(-3f))
    }
}
