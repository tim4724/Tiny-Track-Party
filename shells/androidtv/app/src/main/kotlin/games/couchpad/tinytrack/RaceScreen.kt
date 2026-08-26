package games.couchpad.tinytrack

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.updateTransition
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlinx.coroutines.delay

/**
 * The per-cell race chrome: name chip, item slot, place/lap readout, the FINISHED
 * card and the reconnect card.
 *
 * **EVERYTHING IS PLACED FROM `GameState.CellHUD.rect`, and nothing else.** That
 * rect is `ttp_display_cell_rects`' answer — the LETTERBOXED cell, capped at
 * `CELL_MAX_ASPECT` and centred as one piece, which is where the camera actually
 * rendered. A grid computed here, or the view's own bounds divided by the cell
 * count, is a second opinion and it will disagree: two players on a 16:9 screen
 * are STACKED, and their cells are 1260x540 with 330 px bars either side, not
 * 1920x540.
 *
 * **WHAT THIS FILE MAY NOT DRAW.** The steer bar and the cell dividers are the
 * RENDERER's (`materials/voverlay.mat`), from these same rects. Drawing them here
 * would double them, and the second copy would drift. The line is exact:
 * **cell-anchored AND textless goes to the renderer; anything carrying type or
 * sticker chrome stays here.**
 *
 * Chrome over the live race view floats BARE — no paper, no panel. Paper
 * backgrounds are for full-screen boards only.
 *
 * Nothing in here is focusable. A TV's focus system drives the whole UI, and a HUD
 * element that could take focus would steal it from the pause overlay, which is
 * the only thing on this screen a remote is meant to reach.
 */
@Composable
fun RaceHud(state: GameState) {
    // NO SURFACE WIDTH HERE. The rects arrive in AUTHORED units already, converted
    // where they were read against the width current at that instant
    // (`GameCoordinator.paintHUD`). Taking the width separately is what let the
    // two disagree across an adaptive-scale move.
    Box(Modifier.fillMaxSize()) {
        for (cell in state.cells) {
            CellChrome(cell, state)
        }
    }
}

@Composable
private fun CellChrome(cell: GameState.CellHUD, state: GameState) {
    // FINISHED wins the cell if a car is somehow both finished and dropped. The
    // coordinator already resolves that when it builds the row; this is the rule
    // stated a second time where the card is actually drawn.
    val showsReconnect = cell.reconnecting && !cell.finished
    val cardInCell = cell.finished || showsReconnect

    // TWO BOXES, on the cell's two rects. The chips hang off a CORNER, and a
    // corner is what a television that overscans crops, so they are laid out in
    // the SAFE rect and their authored margins become margins from the safe edge.
    // The cards are CENTRED on the picture: pulling them into the safe rect would
    // shift them off the middle of the very thing they cover, in any cell with an
    // outer edge. `CellRect` carries both because C++ answers both in one read.
    Box(
        Modifier
            .offset(cell.rect.sx.dp, cell.rect.sy.dp)
            .size(cell.rect.sw.dp, cell.rect.sh.dp)
    ) {
        // `.cell-label`'s margin. In AUTHORED pixels, which is what the whole tree
        // is in under the root density override.
        val margin = 11.dp

        if (!cell.reconnecting) {
            // Hidden under the reconnect card because that card already shows the
            // name, so the chip would just repeat it. The FINISHED card carries no
            // name, so it keeps the chip.
            Column(
                Modifier.padding(margin).align(Alignment.TopStart),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                NameChip(cell.name, cell.colorIndex)
                ItemSlot(
                    item = cell.item,
                    accent = state.boostAccent,
                    carIndex = cell.carIndex,
                    tick = state.itemPickupTick[cell.car] ?: 0,
                )
            }
        }

        if (!cardInCell) {
            Column(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = margin, end = 12.dp)
                    .tilt(1.5f),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                // A cell whose car has no live HUD row this tick reports 0 — that
                // is the readback SKIPPING a slot no live car claims, which is what
                // stops a Grand Prix swapping tracks under the HUD from painting
                // "0th, lap 0".
                if (cell.place > 0) {
                    val shape = RoundedCornerShape(Sticker.radiusSmall)
                    Box(
                        Modifier
                            .hardShadow(Sticker.popShadow, shape)
                            .background(Tokens.surface, shape)
                            .stickerOutline(Sticker.border, shape)
                            .padding(vertical = 10.dp, horizontal = 21.dp)
                    ) {
                        StickerText(Copy.ordinal(cell.place), size = 46.dp)
                    }
                }
                if (cell.totalLaps > 0) {
                    StickerPill(Copy.lap(cell.lap, cell.totalLaps), tint = Tokens.ink, tracking = 0.12f)
                }
            }
        }
    }

    Box(
        Modifier
            .offset(cell.rect.x.dp, cell.rect.y.dp)
            .size(cell.rect.w.dp, cell.rect.h.dp)
    ) {
        if (cell.finished) {
            Box(Modifier.align(Alignment.Center)) { FinishedCard(cell) }
        } else if (showsReconnect) {
            Box(Modifier.align(Alignment.Center)) { ReconnectCard(cell) }
        }
    }
}

/**
 * `.cell-label__name` — the player's name in their LIVERY on a white sticker. The
 * livery is the text colour here, not a dot, which is why this is not the web's
 * `.chip` token: in a cell the car right below it is already the swatch.
 */
@Composable
private fun NameChip(name: String, colorIndex: Int) {
    val size = 35.dp
    val shape = RoundedCornerShape(Sticker.radiusSmall)
    Box(
        Modifier
            .tilt(-2f)
            .hardShadow(Sticker.popShadow, shape)
            .background(Tokens.surface, shape)
            .stickerOutline(Sticker.border, shape)
            .padding(vertical = size * 0.3f, horizontal = size * 0.55f)
    ) {
        StickerText(
            name, size = size, color = Tokens.car(colorIndex),
            // `max-width: 14em`, so a long name truncates rather than running
            // across the cell into the next player's picture.
            modifier = Modifier.widthIn(max = size * 14),
        )
    }
}

/**
 * The held-item slot: a FIXED reserved square (so nothing reflows when it is
 * empty) that SLOT-MACHINES on every pickup.
 *
 * **A fresh pickup re-spins even on the same item id.** A box swap can re-roll
 * what you already had, and a slot that only animated on CHANGE would say nothing
 * at all on that pickup — so the trigger is the pickup, not the value.
 */
@Composable
private fun ItemSlot(item: String?, accent: Int, carIndex: Int, tick: Int) {
    // `clamp(112px, 10vw, 152px)` on a 1920-wide display: 10vw is 192, so the clamp
    // lands on its 152 ceiling. VIEWPORT width, not cell width — the slot is the
    // same size in a four-way split as it is full screen.
    val side = 152.dp
    val corner = 26.dp
    val shape = RoundedCornerShape(corner)

    var rolling by remember { mutableStateOf<String?>(null) }
    var landed by remember { mutableIntStateOf(0) }
    val shown = rolling ?: item

    // The web's `_rouletteChip`, beat for beat: flick through the item keys,
    // decelerating, then land on the real item with a pop. Self-driven because it
    // animates far faster than the ~6 Hz HUD poll that feeds this view.
    LaunchedEffect(item, tick) {
        val keys = ItemVocabulary.keys
        if (item == null || keys.isEmpty()) { rolling = null; return@LaunchedEffect }
        // 8 flicks then land, at 35 + 16n ms each: 51, 67 … 163. The deceleration
        // is what makes it read as a slot machine coming to rest rather than as a
        // flicker.
        for (n in 1..8) {
            rolling = keys[(n - 1) % keys.size]
            delay((35 + n * 16).toLong())
        }
        rolling = null
        landed += 1
    }

    // `cellItemPop`: 0.5s, scale 1.8 -> 1. STARTING AT 1.8 is the part that needs a
    // keyframe track — animating FROM the current value would render a hold at full
    // size the web does not have.
    val pop = updateTransition(landed, label = "pop")
    // NOT `by`. Every one of these values is read inside the `graphicsLayer` block
    // below rather than here — see the comment there for why the distinction is the
    // whole cost of this slot.
    val popScale = pop.animateFloat(
        transitionSpec = {
            keyframes {
                durationMillis = 500
                1.8f at 0 using LinearEasing
                1.15f at 220
                1f at 500
            }
        },
        label = "popScale",
    ) { 1f }

    // `cellItemRoll`: a 0.1 s scale/tilt flicker WHILE the slot rolls. Without it the
    // roll is a sequence of still pictures swapping, which reads as a glitch rather
    // than as a slot machine — the deceleration alone does not carry it.
    //
    // AN `Animatable` KEYED ON `rolling`, NOT A `rememberInfiniteTransition`. An
    // InfiniteTransition runs from first composition until the composable leaves,
    // whether or not anything reads it — so every cell held a Compose frame-clock
    // awaiter for the whole race, and Compose broadcasts a frame to every awaiter on
    // every vsync. Measured with `atrace`: ~1.1 ms of main-thread time on 100 % of
    // frames, on the one thread the renderer also draws on, for an animation that is
    // idle. The spec is the same 0.1 s linear repeat; it just only exists while it is
    // wanted, and cancelling the effect is what stops it.
    val wobble = remember { Animatable(0f) }
    LaunchedEffect(rolling != null) {
        if (rolling == null) wobble.snapTo(0f)
        else wobble.animateTo(1f, infiniteRepeatable(tween(100, easing = LinearEasing)))
    }

    Box(
        Modifier
            .size(side)
            .graphicsLayer {
                // EVERY ANIMATED VALUE IS READ HERE, inside the layer block, and that
                // is the difference between a slot machine and a dropped frame. A read
                // in the composition subscribes the whole slot to a value that changes
                // on every vsync, so one pickup recomposed `ItemSlot` on every frame of
                // the roll and re-ran the icon's vector draw with it. Read here, a new
                // frame re-runs this block and nothing else.
                //
                // The roll transform applies ONLY while `.rolling` is set, exactly as
                // the CSS class does. At rest the class is absent and the slot carries
                // no transform of its own — evaluating the keyframe's 0 % stop instead
                // left every idle slot 12 % oversized and tilted four degrees.
                val phase = rolling?.let { 1f - abs(wobble.value * 2f - 1f) }
                val s = popScale.value * (phase?.let { 1.12f + (0.97f - 1.12f) * it } ?: 1f)
                scaleX = s
                scaleY = s
                rotationZ = phase?.let { -4f + 8f * it } ?: 0f
            }
            .then(
                if (shown != null) Modifier
                    .hardShadow(Sticker.popShadow, shape)
                    .background(Tokens.surface, shape)
                    .stickerOutline(Sticker.border, shape)
                // The empty slot reads as a RESERVED SPACE rather than a sticker:
                // no fill, no shadow, and a DASHED rule. `border: 4px dashed
                // color-mix(ink 45%, transparent)`.
                else Modifier.dashedOutline(
                    Sticker.border, corner, Tokens.ink.copy(alpha = 0.45f)
                )
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (shown != null) {
            ItemIcon.Draw(
                key = shown,
                modifier = Modifier.size(side * 0.7f),
                accent = accent,
                carIndex = carIndex,
            )
        }
    }
}

/**
 * The item vocabulary, DERIVED from the ABI rather than mirrored. `ttp_item_id`
 * names the id a box roll can yield and answers null past the end, so walking it
 * is the same move the audio device makes for its cue table. A shell that walks
 * the export cannot drift in the first place.
 */
private object ItemVocabulary {
    val keys: List<String> by lazy {
        val out = ArrayList<String>()
        var code = 1
        // The bound is a guard against a corrupt artifact answering non-null
        // forever, not a claim about how many items there are.
        while (code < 64) {
            out.add(TtpJson.str(Ttp.ttp_item_id(code)) ?: break)
            code += 1
        }
        out
    }
}

/**
 * Centred in the player's own cell the instant they cross the line, while the rest
 * of the field is still racing. Both of its values are fixed at that moment, so
 * this card is written once and then left alone.
 */
@Composable
private fun FinishedCard(cell: GameState.CellHUD) {
    // `.cell-finish`'s padding is ASYMMETRIC — 20.8 vertical by 35.2 horizontal —
    // so the card is noticeably wider than its stack. Uniform, it hugged.
    StickerCard(rotation = -1.5f, padding = 21.dp, horizontalPadding = 35.dp) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // `.cell-finish__badge` carries the ink rule every other sticker does;
            // a bare `.pill` does not, and without it the badge was the one token on
            // the screen with no outline.
            Box(Modifier.stickerOutline(Sticker.hairlineBorder, RoundedCornerShape(percent = 50))) {
                StickerPill(Copy.finished, tint = Tokens.car(cell.colorIndex), size = 20.dp,
                    tracking = 0.16f)
            }
            StickerText(Copy.ordinal(cell.place), size = 54.dp)
            // A car can be FINISHED with no recorded time — a forfeit resolved at
            // the flag — and the card prints nothing rather than "0.0s" for it.
            cell.finishTime?.let {
                StickerText(Copy.seconds(it), size = 22.dp, color = Tokens.ink2, body = true)
            }
        }
    }
}

/**
 * A dropped player's rejoin QR, centred in their cell exactly like the FINISHED
 * card while their car keeps its place on track.
 *
 * The URL is composed in C++ and carries `?claim=<peerIndex>`, which is what lets
 * a DIFFERENT device take the seat over. Only the bitmap is this platform's.
 */
@Composable
private fun ReconnectCard(cell: GameState.CellHUD) {
    val qrSide: Dp = 132.dp
    // Rendered once per URL rather than per recomposition. This view is rebuilt by
    // the ~6 Hz HUD poll, and a QR encode is not something to run six times a
    // second in a layout pass.
    val bitmap = remember(cell.reconnectUrl) { cell.reconnectUrl?.let { QRCode.bitmap(it) } }
    StickerCard(rotation = -1.5f, padding = 18.dp) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            StickerText(cell.name, size = 22.dp, modifier = Modifier.widthIn(max = qrSide + 44.dp))
            // `.rc-card__sub` is BODY type at 0.72rem — a quiet caption under the
            // name. In the display face at 16 dp it measured a third wider and half
            // again taller, and at that weight the warm ink-3 read as a solid tan
            // label competing with the name above it.
            StickerText(
                Copy.disconnected.uppercase(), size = 12.dp,
                color = Tokens.ink3, tracking = 0.02f, body = true,
            )
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = null,
                    modifier = Modifier.size(qrSide),
                    // FILTERED, for the reason the lobby ticket's QR is: this is a
                    // heavy downscale, and point-sampling one throws away most of
                    // the source. A thinned module is unrecoverable by a decoder; a
                    // softened edge is not.
                    filterQuality = FilterQuality.High,
                )
            }
            // Never a blank card: a dropped seat with no URL yet still says whose
            // it is and that they are gone.
        }
    }
}

// -- the countdown ----------------------------------------------------------

/**
 * The countdown banner: "3" / "2" / "1" / "GO!". The beat is the model's
 * (`show-countdown`), and its SOUND is the wasm's, so there is no cue call here.
 *
 * Takes the TEXT, not the state: the caller holds the last non-null value so the
 * banner still has something to draw while it fades out. See RootScreen.
 */
@Composable
fun CountdownBanner(text: String) {
    if (text.isEmpty()) return
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // DIE-CUT, like everything else on this glass. `#countdown` is
        // `-webkit-text-stroke: 12px #fff` with `paint-order: stroke fill`, plus a
        // hard `drop-shadow(6px 6px 0 var(--shadow-ink))`. The white cut is not
        // decoration: the numeral lands over the dark road, over a place badge and
        // over a name chip, and without it the glyph merges into all three — over
        // the cars it very nearly disappeared.
        //
        // Compose has no text stroke, so this is `Wordmark`'s technique: white
        // copies stamped on a circle behind the fill. The radius is HALF the CSS
        // width, because a text stroke is centred on the outline and only its outer
        // half shows, while an offset copy dilates the glyph by its whole offset.
        val edge = COUNTDOWN_SIZE * (12f / 280.8f) / 2f
        val drop = COUNTDOWN_SIZE * (6f / 280.8f)
        Box(contentAlignment = Alignment.Center) {
            // The hard ink drop first, so the white cut sits over it — and offset by
            // the EDGE PLUS the drop, because the CSS casts its `drop-shadow` from
            // the already-outlined glyph (`paint-order: stroke fill` runs first). At
            // the drop alone the ink copy lands entirely inside the white ring and
            // never emerges, which reads as a numeral lying flat on the glass.
            CountdownGlyph(text, Tokens.shadowInk, Modifier.graphicsLayer {
                translationX = (edge + drop).toPx(); translationY = (edge + drop).toPx()
            })
            for (i in 0 until COUNTDOWN_EDGE_SAMPLES) {
                val a = i.toDouble() / COUNTDOWN_EDGE_SAMPLES * 2 * Math.PI
                CountdownGlyph(text, Color.White, Modifier.graphicsLayer {
                    translationX = (Math.cos(a) * edge.toPx()).toFloat()
                    translationY = (Math.sin(a) * edge.toPx()).toFloat()
                })
            }
            // ONE COLOUR FOR EVERY BEAT, GO included: `#countdown { color: var(--ink) }`,
            // and `.is-go` adds only an opacity/scale fade. Painting GO red gave the
            // banner a role the web's never takes, and made the last beat read as a
            // different object from the three before it.
            CountdownGlyph(text, Tokens.ink)
        }
    }
}

/** One stamp of the numeral. AXIS-ALIGNED: `#countdown` carries no transform, and
 *  the per-numeral slap settles at `rotate(0deg)` — a permanently leaning digit is
 *  the entrance frozen. */
@Composable
private fun CountdownGlyph(text: String, color: Color, modifier: Modifier = Modifier) {
    StickerText(text, size = COUNTDOWN_SIZE, color = color, modifier = modifier)
}

/** `font-size: 26vh` on a 1080-high board. */
private val COUNTDOWN_SIZE = 281.dp
private const val COUNTDOWN_EDGE_SAMPLES = 16

// -- the pause overlay ------------------------------------------------------

@Composable
fun PauseOverlay(game: GameCoordinator) {
    Box(
        // BRIGHT FROSTED PAPER, not a dark veil. `#pause-overlay` is
        // `rgba(255,246,235,0.72)` — the same warm glass the results board uses —
        // so the frozen race washes OUT toward paper and the card reads as sitting
        // on something lit. Scrimming with ink at 45% inverted the value of the
        // whole screen: a name chip's white paper fell from 255 to 166.
        //
        // (The web adds `backdrop-filter: blur(10px)`. There is no equivalent here:
        // Compose's RenderEffect blurs its own subtree, and what is behind this is
        // a SurfaceView composited by SurfaceFlinger in a layer BELOW the app
        // window — nothing in the view hierarchy can reach it. The flat wash is the
        // DECIDED look, not a gap waiting on a blur: see `docs/native-port/shells.md`,
        // "Decided, not owed".)
        Modifier.fillMaxSize().background(Tokens.paper.copy(alpha = 0.72f)),
        contentAlignment = Alignment.Center,
    ) {
        // LEVEL. `.pause-card` carries no transform and neither does `.card` — every
        // other sticker leans, and this one deliberately does not: it is a modal the
        // viewer has to read, not a thing slapped onto the glass.
        StickerCard(rotation = 0f, padding = 48.dp) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(32.dp),
            ) {
                StickerText(Copy.paused, size = 54.dp)
                // TAKE FOCUS. A TV has no pointer, so an unfocused screen is a
                // DEAD screen: nothing lifts, and the viewer's natural first press
                // — OK, not a direction — goes nowhere. Both tvOS twins use
                // `.defaultFocus` for this reason; nothing in this shell requested
                // focus at all, and these two are its only focusable controls.
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { focus.requestFocus() }
                // A ROW. `.pause-card__btns` is `display: flex; gap: 1rem;
                // justify-content: center` — the two choices sit side by side, which
                // is what keeps the card landscape and reads as a choice rather than
                // as a list. Stacked, the same two buttons turned the card portrait.
                // `size = BUTTON_SIZE` on both: StickerButton's DEFAULT is the
                // welcome board's CTA scale, and its padding is em-relative, so
                // taking the default here carried the whole box with the type and
                // made the buttons outweigh the card's own title.
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    StickerButton(
                        Copy.continueLabel,
                        modifier = Modifier.focusRequester(focus)
                            .defaultMinSize(minWidth = BUTTON_MIN_WIDTH),
                        tint = Tokens.green,
                        size = BUTTON_SIZE,
                    ) { game.resumeRace() }
                    // GHOST — the quiet secondary. An ink-filled primary here reads
                    // as the LOUD option beside a green Continue, which is a
                    // different button rather than a quieter one.
                    StickerButton(
                        Copy.newGameLabel,
                        modifier = Modifier.defaultMinSize(minWidth = BUTTON_MIN_WIDTH),
                        ghost = true, size = BUTTON_SIZE,
                    ) { game.returnToLobby() }
                }
            }
        }
    }
}

/**
 * `.btn`'s own scale, `font-size: 1.15rem`.
 *
 * [StickerButton]'s default is the WELCOME board's CTA (34 dp), and its padding is
 * em-relative — so taking the default on an ordinary button carries the whole box
 * with the type and the control ends up outweighing whatever it is under.
 */
internal val BUTTON_SIZE = 18.dp

/** `.pause-card__btns .btn { min-width: 9rem }`, so the pair reads as a matched set. */
private val BUTTON_MIN_WIDTH = 144.dp
