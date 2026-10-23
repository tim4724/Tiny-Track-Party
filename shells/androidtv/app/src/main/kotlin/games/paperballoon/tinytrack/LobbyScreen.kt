package games.paperballoon.tinytrack

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * How long the lobby's paper takes to get out of the way, in ms — except under
 * the boot cover, where it SNAPS: a fade nobody can see would only hold the cover
 * up for its length, and a cover lifted on a fade half-run reads as three steps
 * (title, wallpaper, circuit) where it should be two. tvOS spells it
 * `LobbyView.backdropFade`.
 */
const val BACKDROP_FADE_MS = 450

/**
 * The lobby board: the join ticket on the left, the race card on the right, and
 * the seat dock hanging from the bottom of the middle. What is left of that
 * middle is where the track preview is meant to be seen, and it is the reason
 * the two side cards are rails rather than a centred stack.
 *
 * **THERE IS NO START BUTTON ON THIS BOARD, and its absence is the design.** The
 * host already has the affordance: the phone they picked the cup on has a START
 * button (`MSG.START_GAME`), which this display obeys — it is not a control the TV
 * was missing, it is a control the TV would be DUPLICATING. And the duplicate is
 * not equivalent, it is weaker: it skips the "who". Whoever holds the remote
 * starts the race, which on a sofa with four phones is whoever is nearest the
 * coffee table. What it cost the tvOS shell was a second road into `startRace()`
 * that the web has no twin for, and therefore no shared test.
 */
@Composable
fun LobbyScreen(state: GameState) {
    Box(Modifier.fillMaxSize()) {
        // A FOCUS STOP THAT DRAWS NOTHING, holding the remote at the foot of the
        // board while the lobby is just standing there.
        //
        // **THE ⓘ MUST NOT BE FOCUSED WHEN THE LOBBY APPEARS**, and it takes a
        // second focusable to keep it that way: Compose grants focus to the first
        // focusable in the tree the moment the WINDOW takes focus (which here is
        // the moment the boot cover lifts and MainActivity drops
        // FLAG_NOT_FOCUSABLE), so a board with exactly one control opens with that
        // control lit up — a blue badge burning in the corner of a screen the room
        // is looking at to read a join code. Measured on the box, not assumed: the
        // first build of this board came up with the ⓘ already blue.
        //
        // IT ASKS FOR FOCUS RATHER THAN RELYING ON BEING FIRST, and that is the
        // half that was measured wrong once: declaring it first in the Box is NOT
        // enough — the badge still came up blue — so the park requests focus
        // itself, when the cover lifts and the window is about to take focus.
        //
        // It sits along the BOTTOM EDGE so the geometry is honest: Up from here is
        // the badge, and there is nothing else to reach. Select on it does nothing,
        // deliberately — the board has no default action. tvOS needs the identical
        // trick for the identical reason (`LobbyView.focusPark`).
        //
        // AND AGAIN WHEN THE INFO BOARD CLOSES, for the same reason: the button
        // that had focus went with the board, so without this the next d-pad
        // press seats focus wherever Compose finds it — which is the ⓘ lighting
        // up on a board the room is reading a join code off.
        val park = remember { FocusRequester() }
        val boardOnTop = state.infoPath.isNotEmpty()
        // ...and again when the connection overlay leaves: its RECONNECT held
        // focus, and Compose hands a vanished focus target's place to the next
        // focusable in traversal order, which is the ⓘ — seen lit blue on the
        // emulator the moment a reconnect landed.
        LaunchedEffect(state.cover, boardOnTop, state.link == null) {
            if (state.cover != "boot" && !boardOnTop && state.link == null) park.requestFocus()
        }
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(40.dp)
                .focusRequester(park)
                .focusable()
        )

        // Paper before a track is picked, the live 3D preview after.
        //
        // The crossfade is a fade of the PAPER, not of the scene: the surface is a
        // sibling BENEATH this whole composition and keeps drawing underneath, so
        // this has nothing to switch off — it gets out of the way. `sceneVisible`
        // is set by the coordinator, never derived here.
        val paper by animateFloatAsState(
            if (state.sceneVisible) 0f else 1f,
            if (state.cover == "boot") snap() else tween(BACKDROP_FADE_MS), label = "backdrop",
        )
        if (paper > 0f) PaperStage(Modifier.alpha(paper))

        // ONE BAND, and the dock is BESIDE the rails rather than under them —
        // the web's `grid-template-areas: "ticket dock race"`. It used to be the
        // second row of a Column, which made the board's height the tallest rail
        // plus the dock and, on the web where the viewport is not fixed at 1080p,
        // pushed the cars off the bottom edge. The box never overflowed (a TV
        // board is one known size) but the composition is the same one on three
        // platforms, so it follows the same way: the middle is the space the
        // rails leave, and the dock hangs from the bottom of it.
        Row(
            Modifier
                .fillMaxSize()
                // A TV's own overscan margin, from the token the web's CSS is
                // authored in. The HUD deliberately takes none HERE — its rects
                // arrive already inset from C++, which is the only side that
                // knows which cell edges are screen edges — but a full-screen
                // board runs to the bezel and has to keep clear of it itself.
                .padding(horizontal = Tokens.safeMarginX, vertical = Tokens.safeMarginY),
            horizontalArrangement = Arrangement.spacedBy(36.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.width(TICKET_WIDTH)) { JoinTicket(state) }
            Box(
                Modifier.weight(1f).fillMaxHeight(),
                contentAlignment = Alignment.BottomCenter,
            ) { SeatDock(state) }
            // THE RACE RAIL IS A COLUMN: the pick floats in the middle of its free
            // space and the shelf keeps the floor, which is `.cup-slot { margin:
            // auto 0 }`. The spacer BELOW the pick is the load-bearing half — the
            // pick is absent until the host chooses, and a `space-between` rail
            // would park the lone shelf at the top pre-pick and then drop it when
            // the pick arrived, which is the one movement the arrangement exists
            // to stop. Two spacers over nothing still leave the shelf on the floor.
            Column(
                Modifier
                    .width(RACE_RAIL_WIDTH)
                    .fillMaxHeight()
                    // CLEAR THE ⓘ, which is fixed over this board's top-right
                    // corner and would otherwise sit on the pick card. Both
                    // siblings measure from the same safe edge, so the rail
                    // owes only the badge's size plus its air — the overscan
                    // margin is already in the Row's padding above and must not
                    // be counted twice. The web says the same thing as
                    // `.race-rail { padding-top: ... }` and tvOS as
                    // `.padding(.top, InfoGlyph.diameter + 10)`.
                    .padding(top = RACE_RAIL_TOP_CLEAR),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.weight(1f))
                // HIDDEN ENTIRELY pre-pick — not an empty card, not a
                // placeholder. The model answers null until the host has picked,
                // and an empty card would promise a pick with nothing to say.
                state.cupSlot?.let { CupCard(it) }
                Spacer(Modifier.weight(1f))
                if (state.cups.isNotEmpty()) CupShelf(state.cups, state.starsEarned, state.starsTotal)
            }
        }

        // THE INFO CORNER, and the only control on this board.
        //
        // It opens the legal branch (privacy, imprint, licenses), which is the one
        // thing a TV app owes its viewer that no phone in the room can show them.
        // Everything else here is still driven from the phones — see the note above
        // about the START button that is deliberately absent.
        //
        // TOP-RIGHT, the same corner tvOS puts it in (`LobbyView`). It sat
        // top-LEFT until the perf readout moved: that overlay held this corner
        // over every board, and a black diagnostic block over the only control on
        // the board is worst exactly when a developer is reading the lobby. The
        // readout is bottom-right now, which is where tvOS always kept it, so the
        // one deliberate difference between the two shells is gone.
        //
        // UNLIT UNTIL ASKED FOR, which is the park above's whole job: Compose
        // seats focus somewhere the moment the window takes it, so without a
        // second stop to absorb that this badge is what opens lit. It brightens
        // when a viewer actually presses Up, and the room reads the join code off
        // an unlit board until then.
        // ON the overscan margin, with no offset of its own: this badge is a
        // sibling of the padded Row above, not a child of it, so it takes the
        // same margin itself and its edges line up with the cards it floats over.
        // It carried an extra 16dp until the web's corner row lost the matching
        // `--corner-inset` — an inset there put the buttons OUTSIDE the content,
        // and one here put the badge inside it. tvOS takes neither: the system
        // safe area it reports is already bigger than this token.
        //
        // THE BACKEND'S NAME SITS BESIDE IT, in the lobby's quiet grey: the
        // one fact about this box a player can read off the sofa that decides
        // which perf ledger applies (the two drivers share none). It stays inside
        // the band the race rail already clears for the badge.
        Row(
            Modifier
                .align(Alignment.TopEnd)
                .padding(end = Tokens.safeMarginX, top = Tokens.safeMarginY),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.backend.isNotEmpty()) {
                StickerText(state.backend, size = 20.dp, weight = Fonts.semibold, color = Tokens.ink2)
            }
            InfoBadge { state.infoPath = listOf(GameState.InfoRoute.Info) }
        }
    }
}

/**
 * The ⓘ: a CHOICE, the web's `.icon-btn` — a round white key with the faint edge
 * and a drawn "i" in it.
 *
 * DRAWN, not typed: the glyph is a dot over a stem, which is two primitives and
 * no dependency on a font having a legible dotted lowercase i at badge size — the
 * same call `StarRow` and `LockGlyph` make beside it.
 *
 * Focused it is washed in `--pick` and ringed, the same "you are here" every
 * control in this branch wears.
 */
@Composable
private fun InfoBadge(modifier: Modifier = Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val diameter = INFO_BADGE_DIAMETER
    Box(
        modifier
            .size(diameter)
            .focusRing(focused, diameter / 2, gap = 3.dp)
            .background(if (focused) Tokens.pick else Tokens.surface, CircleShape)
            .border(Sticker.edgeWidth, Tokens.edge, CircleShape)
            .onFocusChanged { focused = it.isFocused }
            // The badge is icon-only, so this is the whole announcement.
            .semantics { contentDescription = Copy.info }
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        val ink = Tokens.ink
        Canvas(Modifier.size(diameter)) {
            // A DrawScope is in PHYSICAL pixels — the density override buys the
            // layout tree its authored dp and buys a Canvas body nothing.
            // The same two shapes at the same fractions of the key as tvOS's
            // InfoGlyph: the dot's centre at 0.29, the bar 0.44-0.74 including
            // its round caps (which a line's endpoints do not count).
            val d = size.width
            val cx = d / 2f
            val bar = d * 0.155f
            drawCircle(ink, radius = d * 0.085f, center = Offset(cx, d * 0.29f))
            drawLine(
                ink,
                Offset(cx, d * 0.44f + bar / 2f),
                Offset(cx, d * 0.74f - bar / 2f),
                strokeWidth = bar,
                cap = StrokeCap.Round,
            )
        }
    }
}

// -- (a) the join ticket ----------------------------------------------------

@Composable
private fun JoinTicket(state: GameState) {
    val open = state.joinUrl.isNotEmpty()
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        TicketCard(state, open)
        ScanHint(open)
    }
}

@Composable
private fun TicketCard(state: GameState, open: Boolean) {
    // `.ticket`'s `padding: 0.85rem 0.85rem 1rem` — a thin paper margin, so the QR
    // fills the card.
    PaperCard(padding = TICKET_PAD) {
        Column(
            Modifier.fillMaxWidth().padding(bottom = 2.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Wordmark(size = 38.dp)

            // A BARE SQUARE, not a framed panel. `#qr` is a canvas with a 6px radius
            // and NO border — while the room warms it is simply white paper, which
            // is the "warming up" face. An outlined empty box reads as an element
            // that failed to load.
            //
            // `width: 100%; aspect-ratio: 1/1`, so the QR is the ticket's main
            // element rather than a small square marooned in a field of white.
            Box(
                Modifier.fillMaxWidth().aspectRatio(1f),
                contentAlignment = Alignment.Center,
            ) {
                state.joinQr?.let { qr ->
                    Image(
                        bitmap = qr.asImageBitmap(),
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        // FILTERED, deliberately: this bitmap is ~800 px and the
                        // panel is smaller, so what happens to it is a heavy
                        // DOWNSCALE, and point-sampling a downscale throws away most
                        // of the source rather than preserving it. A thinned or
                        // merged module is unrecoverable by a decoder; a softened
                        // edge is not.
                        filterQuality = FilterQuality.High,
                        contentScale = ContentScale.Fit,
                    )
                }
            }

            // THE URL BOX RESERVES ITS FINAL FOOTPRINT (`min-height: 3.4em`) before
            // the room opens, so the card does not grow — and re-centre in its rail —
            // at the moment the code arrives. Until then it reads "Loading…".
            //
            // The HOST LINE is not decoration: it is the type-it-in fallback for
            // anyone who cannot scan, which on a television is the whole second half
            // of the join story. It was missing entirely, while `state.joinUrl` sat
            // populated and unread.
            Box(
                Modifier.fillMaxWidth().heightIn(min = URL_SIZE * 3.4f),
                contentAlignment = Alignment.Center,
            ) {
                if (!open) {
                    StickerText(Copy.loading, size = URL_SIZE, color = Tokens.ink2)
                } else {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        StickerText(
                            joinHost(state.joinUrl, state.roomCode),
                            size = URL_SIZE, weight = Fonts.semibold,
                            color = Tokens.ink, maxLines = 2, center = true,
                        )
                        if (state.roomCode.isNotEmpty()) {
                            // `.ticket__cd` — in BLUE, and the only part of the
                            // ticket that changes per party. In ink it read as a
                            // heading detached from any address.
                            StickerText(
                                state.roomCode, size = URL_SIZE * 1.45f,
                                color = Tokens.blue, tracking = 0.08f,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * The scan hint: a GLASS readout hanging under the ticket, as on tvOS
 * (`LobbyView.scanHint`) and the web (`.tagline`) — white type on the dark
 * tint, over the live preview it floats on.
 *
 * NO BLUR, which the web adds (`backdrop-filter: blur(12px)`): the picture behind
 * is the SurfaceView, which nothing in the view tree can sample, and the tint
 * alone reads the same at this size.
 *
 * HELD BACK UNTIL THERE IS SOMETHING TO SCAN (`.ticket-rail:has(#qr.is-in)
 * .tagline`): a board that says "scan the code" over a blank white square is
 * instructing the room to scan nothing. Hidden through a `graphicsLayer` alpha,
 * which keeps its box, so the ticket does not re-centre when it appears.
 */
@Composable
private fun ScanHint(open: Boolean) {
    Box(
        Modifier
            // One line, overhanging the ticket rather than wrapping (tvOS's
            // `fixedSize()`).
            .wrapContentWidth(unbounded = true)
            .graphicsLayer { alpha = if (open) 1f else 0f }
            .background(Tokens.glass, RoundedCornerShape(Sticker.radius))
            // `padding: 0.6em 1.1em` at the hint's 22.
            .padding(vertical = 13.dp, horizontal = 24.dp),
    ) {
        StickerText(Copy.scanPrompt, size = 22.dp, weight = Fonts.semibold, color = Color.White)
    }
}

/**
 * The ticket's host line: what a person would TYPE, which is not what the QR
 * carries.
 *
 * `main.js` composes it as `new URL(joinUrl).host + pathname` and then splits the
 * room code off the tail so the accent line below can carry it. Printing
 * `state.joinUrl` verbatim instead puts the scheme, the `?pbp=androidtv` the
 * launcher contract adds, AND a second copy of the room code on a card whose whole
 * job is to be read from a sofa — the one line that is supposed to be the simple
 * fallback becomes the longest thing on the ticket.
 */
private fun joinHost(joinUrl: String, roomCode: String): String {
    val uri = android.net.Uri.parse(joinUrl)
    val shown = (uri.host ?: joinUrl) + (uri.path ?: "")
    return if (roomCode.isNotEmpty() && shown.endsWith(roomCode)) {
        shown.dropLast(roomCode.length)
    } else {
        shown
    }
}

// -- (b) the race card ------------------------------------------------------

@Composable
private fun CupCard(slot: GameState.CupSlot) {
    // No stars on the card: the Cups shelf right under it shows every cup's.
    // `.cup-slot__pick`'s `padding: 0.9rem 0.8rem 1rem` and `gap: 0.65rem`.
    PaperCard(Modifier.fillMaxWidth(), padding = 15.dp, horizontalPadding = 13.dp) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            CupNameLabel(cupName(slot), slot.cupId)

            if (slot.maps.isNotEmpty()) {
                // A GRID, not a row. `.cup-maps` is `repeat(2, 1fr)`, widening to 3
                // at five tiles (the tour's ladder) and 4 at six or more (a long
                // random run); a single tile takes 72% of the card, centred. Laid in
                // one row the tour card came out landscape and each tile was a third
                // of its intended area.
                //
                // EVERY rung: ttp_ui.cc emits one chip per cup in the ladder, and
                // World Tour's is five — `take(4)` silently dropped its last one.
                val cols = when {
                    slot.maps.size == 1 -> 1
                    slot.maps.size >= 6 -> 4
                    slot.maps.size == 5 -> 3
                    else -> 2
                }
                MapGrid(slot, cols)
            }

            // THE CARD'S FOOTER, under the tiles — `.cup-races` is the last thing in
            // the pick's markup. A quiet LABEL the CSS spells by hand: ink-2 on the
            // sunken surface rather than the tint recipe.
            LabelPill(Copy.races(slot.racesKey, slot.raceCount), size = 15.dp,
                face = Tokens.surface2, ink = Tokens.ink2)
        }
    }
}

/**
 * `.cup-sticker` — the cup's name as a LABEL in the cup's OWN colour, because
 * nothing here is pressed: the colour mixed 34% into white, the words in ink (the
 * label recipe's darkened type turns muddy on a pale cup colour, Beach's sand). A
 * run that belongs to no cup takes the neutral wash, exactly as its tiles do.
 */
@Composable
private fun CupNameLabel(name: String, cupId: String?) {
    val size = 27.dp   // `clamp(1.2rem, 1.8vw, 1.7rem)` at 1920
    Box(
        Modifier
            .background(cupTint(cupId, 34.0), RoundedCornerShape(percent = 50))
            .padding(top = size * 0.35f, bottom = size * 0.4f,
                start = size * 0.85f, end = size * 0.85f),
    ) {
        StickerText(name, size = size, color = Tokens.ink, lineHeight = 1.05f)
    }
}

/** `.cup-maps` — the picked circuits, [cols] to a row. */
@Composable
private fun MapGrid(slot: GameState.CupSlot, cols: Int) {
    val tint = slot.cupId?.let { cupTint(it) }
    Column(
        Modifier.fillMaxWidth(if (cols == 1) 0.72f else 1f),
        verticalArrangement = Arrangement.spacedBy(MAP_GAP),
    ) {
        for (row in slot.maps.chunked(cols)) {
            Row(horizontalArrangement = Arrangement.spacedBy(MAP_GAP)) {
                for (m in row) Box(Modifier.weight(1f)) { MapTile(m, tint) }
                // Pad the last row so a ragged tail keeps the grid's column width
                // rather than stretching its tiles across it.
                repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/**
 * The tile field's wash: this cup's colour mixed toward white by the shared
 * percentage, so the phone's picker and every TV lobby wash the same map to the
 * same shade. The mix is `ttp_ui_cup_tint_rgb`'s.
 *
 * TWO EXPORTS, because there are two kinds of absence. A chip that names no cup
 * takes the NEUTRAL wash — a warm grey — and NOT `cup_tint_rgb(null)`, which
 * answers the fallback and is itself a cup colour: Random's four tiles came out
 * in the Backyard cup's lawn green, dressed as a cup they have nothing to do
 * with. `trackPicker.js` has kept the pair apart as `cupTint`/`neutralTint` all
 * along; this shell is what made the second one exist over here.
 *
 * [pct] is how much of the colour survives: the field's shared share by default,
 * 100 for a shelf dot, 34 for the name label (`.cup-sticker`).
 */
private fun cupTint(cupId: String?, pct: Double = Ttp.ttp_ui_cup_field_tint_pct().toDouble()): Color {
    val rgb = if (cupId.isNullOrEmpty()) Ttp.ttp_ui_neutral_tint_rgb(pct)
        else Ttp.ttp_ui_cup_tint_rgb(TtpJson.arg(cupId), pct)
    return Color(rgb or 0xFF000000.toInt())
}

/** `Copy` owns the two English strings; the model answers keys plus data. */
private fun cupName(slot: GameState.CupSlot): String = when (slot.nameKey) {
    "random" -> Copy.random
    "tour" -> Copy.worldTour
    else -> slot.name ?: Copy.unknownValue
}

/**
 * One circuit chip. [cardTint] is the CARD's cup wash, which a chip naming its own
 * cup outranks.
 */
@Composable
private fun MapTile(map: GameState.CupSlot.Map, cardTint: Color?) {
    // `border-radius: 14px`, a literal in the CSS too: a tile is a flat field with
    // no outline, its corner a step softer than `--r-sm`.
    val shape = RoundedCornerShape(14.dp)
    // THREE cases, not two. A LOCKED rung is the tour's teaser: sunken PAPER under a
    // padlock, which shows the ladder without selling it as a race (the races pill
    // never counts it) — `--surface-2`, the out-of-reach grey. An UNDRAWN race takes
    // its OWN cup's colour when the chip names one and the picker's cup-less
    // fallback when it does not — never the card's tint, because an unknown must not
    // borrow the drawn race's colour.
    val field = when {
        map.locked -> Tokens.surface2
        map.trackId == null -> cupTint(map.cup)
        else -> map.cup?.let { cupTint(it) } ?: cardTint ?: cupTint(null)
    }
    Box(Modifier.fillMaxWidth()) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .background(field, shape),
            contentAlignment = Alignment.Center,
        ) {
            BoxWithConstraints {
                // `34cqw` — the glyph tracks its own BOX, so it is a third of the tile
                // whether that tile is the endless card's lone big square or one of a
                // long run's eight small ones.
                val glyph = maxWidth * 0.34f
                when {
                    map.locked -> LockGlyph(size = maxWidth * 0.34f)
                    map.trackId == null ->
                        // FULL INK. At ink-3 the "?" was low-contrast against its own
                        // fill, which made an undrawn race look like a disabled one.
                        StickerText(map.glyph, size = glyph, color = Tokens.ink, lineHeight = 1f)
                    else -> TrackMapCanvas(map.trackId, Modifier.fillMaxSize())
                }
            }
        }
        // `.cup-maps__n` — a badge hung OFF the tile's top-left corner, white on
        // solid ink. Printed in the tile's CENTRE it was standing where the map
        // belongs, which is how a card came to show a "1" instead of a circuit.
        // A 20 dp digit in a 30 dp ink disc: the same geometry on every platform.
        if (map.n > 0) {
            Box(
                Modifier
                    .align(Alignment.TopStart)
                    .offset(x = (-8).dp, y = (-8).dp)
                    .size(30.dp)
                    .background(Tokens.ink, RoundedCornerShape(percent = 50)),
                contentAlignment = Alignment.Center,
            ) {
                StickerText(map.n.toString(), size = 20.dp, weight = Fonts.semibold,
                    color = Color.White, lineHeight = 1f)
            }
        }
    }
}

// -- (b2) the cups shelf ----------------------------------------------------

/**
 * `.cup-shelf` — **the couch's record, on the couch's screen.**
 *
 * A shell can bank stars, persist them and publish them to four phones and still
 * never show the room a single one; the reward arc then exists only on the
 * handsets, which is where nobody is looking. `docs/native-port/shells.md` names
 * this as a FOURTH obligation that the persist/derive/publish three do not imply,
 * and this shell had all three and not this.
 *
 * Every value is the model's: the stars, the lock and the unlock counts are derived
 * in C++ off the stamped catalogue, and a shell that re-implemented a threshold has
 * copied a rule that will drift.
 */
@Composable
private fun CupShelf(cups: List<GameState.CupRow>, starsEarned: Int, starsTotal: Int) {
    Box(Modifier.fillMaxWidth()) {
        // `.cup-shelf`'s `padding: 0.55rem 0.9rem 0.45rem`.
        PaperCard(Modifier.fillMaxWidth(), padding = 8.dp, horizontalPadding = 14.dp) {
            Column(Modifier.fillMaxWidth()) {
                for ((i, cup) in cups.withIndex()) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(9.dp),
                    ) {
                        // A LOCKED row swaps its dot for the padlock and recedes:
                        // it is on the ladder, but it is not a cup you have raced.
                        if (cup.locked) {
                            LockGlyph(size = 15.dp, color = Tokens.ink2)
                        } else {
                            // `.dot` at `0.65rem`: the cup's colour at FULL
                            // strength, not the tiles' washed field.
                            Box(
                                Modifier
                                    .size(11.dp)
                                    .background(cupTint(cup.id, 100.0), CircleShape)
                            )
                        }
                        StickerText(
                            Copy.shortCup(cup.name), size = 21.dp,
                            color = if (cup.locked) Tokens.ink2 else Tokens.ink,
                            modifier = Modifier.weight(1f),
                        )
                        if (cup.locked) {
                            // The unlock bar, counted in stars: "★ 4/6".
                            StarRow(1, size = 16.dp, max = 1)
                            StickerText(
                                "${cup.unlockDone}/${cup.unlockNeed}",
                                size = 18.dp, color = Tokens.ink2,
                            )
                        } else {
                            StarRow(cup.stars, size = 16.dp)
                        }
                    }
                    // `border-bottom: 2px solid var(--hairline)`, last child none.
                    if (i < cups.size - 1) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .height(2.dp)
                                .background(Tokens.hairline)
                        )
                    }
                }
            }
        }
        // The `.pill` tab riding the card's top-left corner, drawn OVER it.
        Box(Modifier.align(Alignment.TopStart).offset(x = 11.dp, y = (-12).dp)) {
            LabelPill(Copy.cupsShelf(starsEarned, starsTotal), size = 14.dp)
        }
    }
}


// -- (c) the seat dock ------------------------------------------------------

@Composable
private fun SeatDock(state: GameState) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.Bottom,
    ) {
        for (seat in state.seats) {
            SeatCard(seat, state.carModels.getOrNull(seat.modelIndex))
        }
    }
}

/**
 * One seat: the car that player picked, over their name in their livery.
 *
 * **THE CARD IS THE SAME HEIGHT WHATEVER IT HOLDS.** `.seat__name` reserves two
 * lines up front and the host/ready marks are absolutely positioned, so the dock is
 * a level row from four empty seats through to a two-line name. When the marks were
 * pills inside the Column instead, the one player who was neither host nor ready
 * rendered a card 23 px shorter, and a bottom-aligned dock hung it visibly low —
 * which reads as a broken card rather than as a missing badge.
 */
@Composable
private fun SeatCard(seat: GameState.Seat, model: String?) {
    val shape = RoundedCornerShape(Sticker.radius)
    Box(
        Modifier
            .width(SEAT_WIDTH)
            // A HELD seat whose phone dropped is DIMMED, deliberately not removed —
            // the seat is still theirs to come back to. A layer alpha, not
            // `Modifier.alpha`, which clips the corner mark hanging off the card.
            .graphicsLayer { alpha = if (seat.off) 0.5f else 1f },
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                // AN OPEN SEAT KEEPS THE FULL FOOTPRINT and changes only its skin:
                // a GLASS placeholder (`.seat--open`, `rgba(24, 28, 44, 0.28)`, a
                // literal there too) so the scene shows through. As white paper,
                // four empty seats read as four cards with nobody on them.
                //
                // NO BLUR behind it, which the web adds: what is behind is the
                // SurfaceView, out of reach of anything in this window, and the
                // tint alone holds the shape.
                .background(if (seat.open) OPEN_SEAT_GLASS else Tokens.surface, shape)
                // `.seat`'s `padding: 0.45rem 0.5rem 0.55rem`.
                .padding(start = 8.dp, end = 8.dp, top = 7.dp, bottom = 9.dp),
        ) {
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                // The car, or the empty square that stands in for one. Both are the
                // baked frames' own 5:4 box, so an open seat is exactly the size of
                // a taken one.
                Box(Modifier.fillMaxWidth().aspectRatio(CarThumb.ASPECT)) {
                    if (!seat.open && model != null) {
                        CarThumbImage(model, Modifier.fillMaxSize())
                    }
                }
                // THE NAME CARRIES THE LIVERY (`.seat__name`, the livery 80% into
                // ink so a pale one still reads on paper), and its box reserves two
                // lines however short the name is, so the
                // card's height never depends on what is in it. maxLines = 2 because
                // `.seat__label` clamps at two and breaks at the space — a long name
                // stacks rather than ellipsising.
                Box(
                    Modifier.fillMaxWidth().height(SEAT_NAME_SIZE * 1.15f * 2),
                    contentAlignment = Alignment.Center,
                ) {
                    StickerText(
                        if (seat.open) Copy.openSeat else seat.name,
                        size = SEAT_NAME_SIZE,
                        color = if (seat.open) Color.White.copy(alpha = 0.85f)
                            else liveryInk(seat.colorIndex),
                        maxLines = 2,
                    )
                }
            }
        }
        // THE CORNER MARKS, over the card and OUT OF ITS LAYOUT — mutually exclusive,
        // because the host never readies, so they share one slot and can never
        // collide. No text: the web draws a check and a star, and a purple "HOST"
        // pill put a chrome colour into a dock that has none.
        if (!seat.open) {
            val corner = Modifier.align(Alignment.TopEnd).offset(x = 12.dp, y = (-13).dp)
            when {
                seat.host -> SeatMark(Tokens.ink, corner) { HostStar() }
                seat.ready -> SeatMark(Tokens.green, corner) { ReadyTick() }
            }
        }
    }
}

/**
 * The seat's corner disc (`.seat__ready`, `.seat__host`): a 1.6rem disc in
 * [fill] with a white glyph, set off the card by a 3px white ring
 * (`box-shadow: 0 0 0 3px #fff`) — drawn as a larger white disc behind it, the
 * ring being outside the 26 px the CSS sizes.
 */
@Composable
private fun SeatMark(fill: Color, modifier: Modifier, glyph: @Composable () -> Unit) {
    Box(
        modifier.size(32.dp).background(Color.White, CircleShape).padding(3.dp)
            .background(fill, CircleShape),
        contentAlignment = Alignment.Center,
    ) { glyph() }
}

/** The ready mark's tick, at 70% of the disc. */
@Composable
private fun ReadyTick() {
    Canvas(Modifier.size(18.dp)) {
        val p = Path().apply {
            moveTo(size.width * 0.2f, size.height * 0.52f)
            lineTo(size.width * 0.42f, size.height * 0.74f)
            lineTo(size.width * 0.82f, size.height * 0.28f)
        }
        drawPath(p, Color.White, style = Stroke(
            width = size.minDimension * 0.19f,
            cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

/** The host mark's white star, at 62% of the disc. No gold: the Toy Box draws the
 *  host on ink, which keeps the dock's one mark out of the vetoed palette. */
@Composable
private fun HostStar() {
    Canvas(Modifier.size(16.dp)) {
        val p = androidx.core.graphics.PathParser.createPathFromPathData(
            "M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.1 6.47L12 17.9l-5.8 3.05 1.1-6.47-4.7-4.58 6.5-.95z"
        ).asComposePath()
        val s = size.minDimension / 24f
        drawContext.transform.scale(s, s, Offset.Zero)
        drawPath(p, Color.White)
    }
}

// -- the board's grid -------------------------------------------------------
//
// `#lobby` is a three-column grid: two rails, and a middle column that carries
// nothing but the seat dock along its floor. The gap above that dock is where
// the live track preview is seen, and it is why the two cards are rails rather
// than a centred stack. The two rail widths below are the CSS's, resolved at
// 1920x1080: `min(clamp(240px, 26vw, 440px), 38vh)` and
// `min(clamp(220px, 24vw, 460px), 32vh)`.
//
// Both rails' cards are `width: 100%` of their column, which is what makes the QR
// the lobby's main element rather than a small square inside a shrink-wrapped card.

private val TICKET_WIDTH = 410.dp
private val RACE_RAIL_WIDTH = 346.dp

/**
 * The ⓘ's size, hoisted because the RACE RAIL has to clear it: the badge is a
 * sibling of the board's column and floats over the rail's top card, so the rail
 * derives its own headroom from this rather than from a number that would drift
 * the first time the badge is resized. tvOS spells the same clearance the same
 * way (`InfoGlyph.diameter`), and the web as `--corner-btn`.
 */
private val INFO_BADGE_DIAMETER = 54.dp

/**
 * What the rail keeps clear at the top so the ⓘ never lands on the pick card.
 * The badge sits on the safe edge and so does the rail, so this is the badge
 * plus a gap and nothing else.
 */
private val RACE_RAIL_TOP_CLEAR = INFO_BADGE_DIAMETER + 10.dp

/** `.ticket`'s `padding: 0.85rem` — a thin paper margin, so the QR fills the card. */
private val TICKET_PAD = 14.dp

/** `.seat--open`'s glass, `rgba(24, 28, 44, 0.28)` — lighter than `--glass`, a
 *  literal in the CSS too. */
private val OPEN_SEAT_GLASS = Color(24, 28, 44).copy(alpha = 0.28f)

/** `.ticket__urlbox`'s type scale; the room code is 1.45em of it. */
private val URL_SIZE = 17.dp

/** `.seat`'s `clamp(100px, 9.5vw, 134px)`, and `.seat__name`'s type scale. */
private val SEAT_WIDTH = 134.dp
private val SEAT_NAME_SIZE = 21.dp

/** `.cup-maps`' `gap: 7px`. */
private val MAP_GAP = 7.dp
