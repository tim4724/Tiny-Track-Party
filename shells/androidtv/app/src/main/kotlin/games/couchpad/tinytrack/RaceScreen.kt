package games.couchpad.tinytrack

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.offset
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
 * chrome stays here.**
 *
 * Chrome over the live race view floats BARE — no panel behind it. The roles it
 * draws in are the theme's: the name chip is the livery, solid on purpose; the
 * place, the item and the cell cards are PAPER; the lap is GLASS.
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
    //
    // Only the FINISHED card OWNS its cell: the race is over for them, so the live
    // chrome has nothing left to say. The reconnect QR does not — their car is
    // still in the race and the HUD keeps reporting it around the card. (The
    // steer bar is the one thing that hides under both, one layer down: the
    // coordinator's cellCards mask, because the bar reports a phone that is gone.)
    val showsReconnect = cell.reconnecting && !cell.finished
    val cardInCell = cell.finished

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
                ready = state.itemReadyTick[cell.car] ?: 0,
            )
        }

        if (!cardInCell) {
            PlaceColumn(
                cell.place, cell.lap, cell.totalLaps,
                Modifier.align(Alignment.TopEnd).padding(top = margin, end = 12.dp),
            )
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
 * The place badge over the lap pill. Its own composable, taking only the three
 * numbers it shows, so a cell recomposing for its item or for anyone's pickup
 * skips it and its retained layer is not re-rendered.
 */
@Composable
private fun PlaceColumn(place: Int, lap: Int, totalLaps: Int, modifier: Modifier) {
    Column(
        modifier.retainedLayer(LAYER_PAD),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        // A cell whose car has no live HUD row this tick reports 0 — that
        // is the readback SKIPPING a slot no live car claims, which is what
        // stops a Grand Prix swapping tracks under the HUD from painting
        // "0th, lap 0".
        if (place > 0) {
            // `.cell-rank__place` — PAPER: the ordinal on a white card.
            val size = 46.dp
            Box(
                Modifier
                    .background(Tokens.surface, RoundedCornerShape(Sticker.radius))
                    .padding(vertical = size * 0.22f, horizontal = size * 0.5f)
            ) {
                StickerText(Copy.ordinal(place), size = size, modifier = Modifier.lineBox(size))
            }
        }
        if (totalLaps > 0) LapPill(Copy.lap(lap, totalLaps))
    }
}

/**
 * `.cell-rank__lap` — GLASS: white caps on the dark tint, a readout over the live
 * view and nothing to press. Small, so it is the one translucent layer on the race
 * screen this box pays for; the web's blur behind it is out of reach here (the
 * picture is the SurfaceView) and the tint alone reads the same at this size.
 */
@Composable
private fun LapPill(text: String) {
    val size = 18.dp
    Box(
        Modifier
            .background(Tokens.glass, RoundedCornerShape(percent = 50))
            .padding(vertical = size * 0.32f, horizontal = size * 0.9f)
    ) {
        StickerText(text.uppercase(), size = size, weight = Fonts.semibold,
            color = Color.White, tracking = 0.12f)
    }
}

/**
 * A chrome group rendered into a RETAINED offscreen layer: HWUI keeps the
 * texture across window frames and re-renders it only when this subtree's
 * display list changes (a place, a lap, an item), so a steady frame composites
 * one quad instead of replaying the group's strokes, fills and text.
 *
 * The layer carries NO transform, so it lands 1:1 at an integer position
 * (Compose layout is integer px) rather than being resampled. A layer clips to
 * its node, so it is grown by [pad] on every side to hold the antialiased edge,
 * and the growth is hidden from layout: the parent measures and places the group
 * exactly where it was.
 */
private fun Modifier.retainedLayer(pad: Dp, block: GraphicsLayerScope.() -> Unit = {}): Modifier =
    layout { measurable, constraints ->
        val p = pad.roundToPx()
        val placeable = measurable.measure(constraints.offset(2 * p, 2 * p))
        layout(placeable.width - 2 * p, placeable.height - 2 * p) { placeable.place(-p, -p) }
    }
        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen; block() }
        // The layer's whole rect, which a covered window erases under it every
        // frame (GameWindow.kt): redrawn over itself, its AA edges would darken.
        .erasedBounds()
        .padding(pad)

/** Room around a retained group for its antialiased edge, and nothing else: the
 *  groups are flat and level, so no drop or rotated corner reaches past them. */
private val LAYER_PAD = 2.dp

/**
 * `.cell-label__name` — the player's name on a pill FILLED with their livery,
 * white text. One of the two things the Toy Box keeps solid on purpose: across a
 * four-way split the thing you hunt for is your own cell, and a solid block of
 * your colour is found in peripheral vision where coloured GLYPHS are not.
 */
@Composable
private fun NameChip(name: String, colorIndex: Int) {
    val size = 35.dp
    Box(
        Modifier
            .retainedLayer(LAYER_PAD)
            .background(Tokens.car(colorIndex), RoundedCornerShape(percent = 50))
            // `padding: 0.28em 0.75em 0.32em`.
            .padding(top = size * 0.28f, bottom = size * 0.32f,
                start = size * 0.75f, end = size * 0.75f)
    ) {
        StickerText(
            name, size = size, color = Color.White,
            // `max-width: 14em`, so a long name truncates rather than running
            // across the cell into the next player's picture.
            modifier = Modifier.widthIn(max = size * 14).lineBox(size),
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
 *
 * **THE ROLL IS THE ICONS ALONE HERE, and that is an Android decision.** The web
 * and tvOS also wobble the slot while it rolls and pop it from 1.8x as it lands
 * (`cellItemRoll`, `cellItemPop`). On this box a transformed slot leaves its
 * retained layer's rect, which puts the window's full-surface clear back
 * ([UnboundedContent]) and redraws the slot on every vsync for the ~1.3 s of
 * each pickup. Without the transform the layer stays retained and is re-rendered
 * once per flick. What that bought is in docs/perf/androidtv-frame-map.md
 * (2026-10-09).
 */
@Composable
private fun ItemSlot(item: String?, accent: Int, carIndex: Int, tick: Int, ready: Int) {
    // `clamp(112px, 10vw, 152px)` on a 1920-wide display: 10vw is 192, so the clamp
    // lands on its 152 ceiling. VIEWPORT width, not cell width — the slot is the
    // same size in a four-way split as it is full screen.
    val side = 152.dp
    // `border-radius: 28px`, a literal in the CSS too.
    val corner = 28.dp
    val shape = RoundedCornerShape(corner)

    var rolling by remember { mutableStateOf<String?>(null) }
    val shown = rolling ?: item

    // The web's `_rouletteChip` flick: through the item keys, decelerating, then
    // the real item. Self-driven because it animates far faster than the ~6 Hz HUD
    // poll that feeds this view.
    LaunchedEffect(item, tick) {
        val keys = ItemVocabulary.keys
        if (item == null || keys.isEmpty()) { rolling = null; return@LaunchedEffect }
        // 8 flicks then land, at 35 + 16n ms each: 51, 67 … 163. The deceleration
        // is what makes it read as a slot machine coming to rest rather than as a
        // flicker.
        for (n in 1..8) {
            rolling = keys[(n - 1) % keys.size]
            delay((35 + n * 16).toLong())
            if (rolling == null) return@LaunchedEffect // `ready` already landed it
        }
        rolling = null
    }
    // The sim's reveal gate opened: a spin still going lands NOW, because a press
    // buffered during it fires on this same tick and the delays only run late.
    // The value at mount is not a gate opening.
    val readyAtMount = remember { ready }
    LaunchedEffect(ready) { if (ready != readyAtMount) rolling = null }

    Box(
        Modifier
            // Its own retained layer.
            .retainedLayer(LAYER_PAD)
            .size(side)
            .then(
                // Holding an item, the slot is PAPER: the icon on a white card.
                if (shown != null) Modifier.background(Tokens.surface, shape)
                // Empty, it reads as a RESERVED SPACE over the live view: a faint
                // dark tint and a DASHED white rule (`.cell-label__item.is-empty`,
                // literals there too).
                else Modifier
                    .background(Color(24, 28, 44).copy(alpha = 0.18f), shape)
                    .dashedOutline(3.dp, corner, Color.White.copy(alpha = 0.75f))
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
 * the export cannot drift in the first place. Not private: `ItemIcon.prewarm`
 * walks the same list.
 */
internal object ItemVocabulary {
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
    UnboundedContent()
    // `.cell-finish`'s padding is ASYMMETRIC — 27.2 vertical by 41.6 horizontal at
    // 1920 — so the card is noticeably wider than its stack. Uniform, it hugged.
    PaperCard(padding = 27.dp, horizontalPadding = 42.dp) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            // `.cell-finish__badge` — a LABEL in the player's livery.
            LabelPill(Copy.finished, tint = Tokens.car(cell.colorIndex), size = 20.dp,
                tracking = 0.16f)
            StickerText(Copy.ordinal(cell.place), size = 54.dp, modifier = Modifier.lineBox(54.dp))
            // A car can be FINISHED with no recorded time — a forfeit resolved at
            // the flag — and the card prints nothing rather than "0.0s" for it.
            cell.finishTime?.let {
                StickerText(Copy.seconds(it), size = 22.dp, weight = Fonts.extraBold,
                    color = Tokens.ink2, body = true)
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
 *
 * No name on it: the corner chip stays up beside the card and already says whose
 * cell this is.
 */
@Composable
private fun ReconnectCard(cell: GameState.CellHUD) {
    UnboundedContent()
    // The QR is BIG, and sized off the CELL — `.cell-reconnect`'s `--qr`: half
    // the screen's height for one player, and most of a split cell, because half
    // of a half-screen cell was too small to scan from the couch and the cell has
    // nothing better to show while its driver is gone. The width cap only bites
    // on a portrait cell. AUTHORED units, like the rect: `50vh` is 540.
    val qrSide: Dp = minOf(540f, cell.rect.h * 0.6f, cell.rect.w * 0.6f).dp
    // The title scales with the QR (`clamp(0.9rem, 8% of the QR, 2.6rem)`).
    val titleSize: Dp = (qrSide.value * 0.08f).coerceIn(14.4f, 41.6f).dp
    // Rendered once per URL rather than per recomposition. This view is rebuilt by
    // the ~6 Hz HUD poll, and a QR encode is not something to run six times a
    // second in a layout pass.
    val bitmap = remember(cell.reconnectUrl) { cell.reconnectUrl?.let { QRCode.bitmap(it) } }
    PaperCard(padding = 18.dp) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(qrSide * 0.04f),
        ) {
            StickerText(Copy.disconnected.uppercase(), size = titleSize, tracking = 0.06f)
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = null,
                    modifier = Modifier.size(qrSide),
                    // FILTERED, for the reason the lobby ticket's QR is: the bitmap
                    // and the frame are never an integer multiple apart (a split
                    // cell's QR is a downscale of it, a solo cell's at 4K about
                    // 1:1), and point-sampling a downscale throws away most of the
                    // source. A thinned module is unrecoverable by a decoder; a
                    // softened edge is not.
                    filterQuality = FilterQuality.High,
                )
            }
            // Never a blank card: a dropped seat with no URL yet still says that
            // they are gone.
        }
    }
}

// -- the countdown ----------------------------------------------------------

/**
 * The banner over the race while the countdown runs, fading in and out.
 *
 * Its own composable so a beat recomposes this and not [RootScreen]. The fade is
 * an [Animatable] read only inside `graphicsLayer`, so it redraws a layer per
 * frame and recomposes nothing; `AnimatedVisibility` ran its transition through
 * composition on every frame of both fades, and the exit lands after GO.
 *
 * The LAST text is held, because the exit is triggered BY the countdown going
 * null: drawing `state.countdown` would render nothing for the whole exit and
 * "GO!" would vanish instead of fading.
 *
 * [defaultSteps] is the protocol's count, for a banner no launch has laid out
 * (`window.COUNTDOWN_SECONDS` on the web).
 */
@Composable
fun CountdownOverlay(state: GameState, defaultSteps: Int) {
    val shown = state.screen == GameState.Screen.RACE && state.countdown != null
    var lastCount by remember { mutableStateOf("") }
    state.countdown?.let { lastCount = it }
    var present by remember { mutableStateOf(false) }
    val fade = remember { Animatable(0f) }
    LaunchedEffect(shown) {
        if (shown) {
            present = true
            fade.animateTo(1f, tween(120))
        } else {
            fade.animateTo(0f, tween(200))
            present = false
        }
    }
    if (present) {
        UnboundedContent()
        val steps = if (state.countdownSteps > 0) state.countdownSteps else defaultSteps
        Box(Modifier.graphicsLayer { alpha = fade.value }) { CountdownBanner(lastCount, steps) }
    }
}

/**
 * The countdown banner (`#countdown`): the beat on a white PAPER disc tipped a
 * few degrees like a toy's dial, and under it a GLASS strip of every beat with
 * the current one lit. GO! turns the disc green. The beat is the model's
 * (`show-countdown`), and its SOUND is the wasm's, so there is no cue call here.
 *
 * Takes the TEXT, not the state: the caller holds the last non-null value so the
 * banner still has something to draw while it fades out.
 *
 * OPAQUE, apart from the strip. The disc is the one large piece of chrome over
 * the live race, and a solid fill is the cheap way to draw it here; it is up for
 * three beats and changes only on a beat.
 */
@Composable
fun CountdownBanner(text: String, steps: Int) {
    if (text.isEmpty()) return
    val go = text == Copy.go
    val n = if (go) 0 else text.toIntOrNull() ?: return
    Box(Modifier.fillMaxSize()) {
        // `.cd-disc`: 34vh across, `margin-top: -4vh` inside a centring flex box,
        // which lifts its centre by half that.
        Box(
            Modifier
                .align(Alignment.Center)
                .offset(y = -(AUTHORED_HEIGHT * 0.02f).dp)
                .size((AUTHORED_HEIGHT * 0.34f).dp)
                .tilt(-4f)
                .background(if (go) Tokens.brand else Tokens.surface, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            // `.cd-num` at 24vh, lifted by half its 1.5vh margin; GO! at 13vh. A
            // "1" centred by its box reads right of centre (its flag reaches
            // left), so it moves left by 0.045em, as on the web.
            val size = (AUTHORED_HEIGHT * (if (go) 0.13f else 0.24f)).dp
            StickerText(
                text, size = size, color = if (go) Color.White else Tokens.ink,
                lineHeight = 1f,
                modifier = Modifier.offset(
                    x = if (n == 1) -size * 0.045f else 0.dp,
                    y = if (go) 0.dp else -(AUTHORED_HEIGHT * 0.0075f).dp,
                ),
            )
        }
        // `.cd-steps`: centred, `4vh` above the bottom safe edge.
        val vh = AUTHORED_HEIGHT / 100f
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = Tokens.safeMarginY + (4 * vh).dp)
                .background(Tokens.glass, RoundedCornerShape(percent = 50))
                .padding((1 * vh).dp),
            horizontalArrangement = Arrangement.spacedBy((0.8f * vh).dp),
        ) {
            for (k in steps downTo 0) CountdownStep(k, now = k == n, vh)
        }
    }
}

/** One `.cd-step`: a disc per number and a wider pill for GO. The lit one is
 *  white with ink (GO's goes green); the rest are white type at 70% on a 14%
 *  white wash, literals in the CSS too. */
@Composable
private fun CountdownStep(k: Int, now: Boolean, vh: Float) {
    val goStep = k == 0
    Box(
        Modifier
            .size(width = ((if (goStep) 9f else 6.4f) * vh).dp, height = (6.4f * vh).dp)
            .background(
                when {
                    now && goStep -> Tokens.brand
                    now -> Color.White
                    else -> Color.White.copy(alpha = 0.14f)
                },
                RoundedCornerShape(percent = 50),
            ),
        contentAlignment = Alignment.Center,
    ) {
        val size = (2.8f * vh).dp
        StickerText(
            if (goStep) Copy.goStep else k.toString(),
            size = size, lineHeight = 1f,
            color = when {
                now && goStep -> Color.White
                now -> Tokens.ink
                else -> Color.White.copy(alpha = 0.7f)
            },
            modifier = Modifier.padding(end = if (k == 1) size * 0.09f else 0.dp),
        )
    }
}

// -- the pause overlay ------------------------------------------------------

/**
 * The pause screen: FROST with the content straight on it, never a card on a
 * scrim — the same screen as the phone's pause.
 *
 * NO BLUR, which the web's frost has (`backdrop-filter: var(--frost-blur)`): the
 * picture behind is the SurfaceView, composited by SurfaceFlinger in a layer
 * BELOW the app window, so nothing in the view hierarchy can sample it, and every
 * route out of Compose costs more than the difference is worth. [Sticker.frost]
 * lays the wash a touch thicker to make up for it.
 */
@Composable
fun PauseOverlay(game: GameCoordinator) {
    UnboundedContent()
    Box(
        Modifier.fillMaxSize().background(Sticker.frost),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(32.dp),
        ) {
            StickerText(Copy.paused, size = OVERLAY_TITLE_SIZE)
            // TAKE FOCUS. A TV has no pointer, so an unfocused screen is a
            // DEAD screen: nothing is lit, and the viewer's natural first press
            // — OK, not a direction — goes nowhere. Both tvOS twins use
            // `.defaultFocus` for this reason; nothing in this shell requested
            // focus at all, and these two are its only focusable controls.
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            // A ROW. `.pause-card__btns` is two EQUAL columns with a 1rem gap —
            // the two choices sit side by side, which reads as a choice rather
            // than as a list.
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                ActionButton(
                    Copy.continueLabel,
                    modifier = Modifier.focusRequester(focus)
                        .defaultMinSize(minWidth = OVERLAY_BUTTON_MIN_WIDTH),
                    tint = Tokens.green,
                    size = OVERLAY_BUTTON_SIZE,
                ) { game.resumeRace() }
                // A CHOICE — the quiet second option, white with the edge. An
                // ink-filled button here reads as the LOUD option beside a green
                // Continue, which is a different button rather than a quieter one.
                ActionButton(
                    Copy.newGameLabel,
                    modifier = Modifier.defaultMinSize(minWidth = OVERLAY_BUTTON_MIN_WIDTH),
                    choice = true, size = OVERLAY_BUTTON_SIZE,
                ) { game.returnToLobby() }
            }
        }
    }
}

/**
 * `.btn`'s own scale, `font-size: 1.15rem`.
 *
 * [ActionButton]'s default is the WELCOME board's CTA (34 dp), and its padding is
 * em-relative — so taking the default on an ordinary button carries the whole box
 * with the type and the control ends up outweighing whatever it is under.
 */
internal val BUTTON_SIZE = 18.dp

/** The full-screen overlays' title, `.pause-card h2` / `.link-card h2` at 4.6rem. */
internal val OVERLAY_TITLE_SIZE = 74.dp

/** The overlays' buttons "step up to TV size": `clamp(1.25rem, 2.3vw, 1.9rem)`. */
internal val OVERLAY_BUTTON_SIZE = 30.dp

/** `.pause-card__btns .btn { min-width: 9em }`, so the pair reads as a matched set. */
internal val OVERLAY_BUTTON_MIN_WIDTH = OVERLAY_BUTTON_SIZE * 9
