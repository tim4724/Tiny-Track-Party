package games.couchpad.tinytrack

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp

/**
 * How long the lobby's paper takes to get out of the way, in ms.
 *
 * NAMED because the boot cover has to outlast it: [GameCoordinator]'s first-paint
 * handler holds the cover for exactly this long, so lifting it can never uncover
 * a fade in progress — which is the opening reading as three steps (title,
 * wallpaper, circuit) where it should be two. Two places, one number; tvOS spells
 * the same pair `LobbyView.backdropFade`.
 */
const val BACKDROP_FADE_MS = 450

/**
 * The lobby board: the join ticket on the left, the race card on the right, the
 * seat dock along the bottom, and the middle deliberately EMPTY — that gap is
 * where the track preview is meant to be seen, and it is the reason the two are
 * rails rather than a centred stack.
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
        LaunchedEffect(state.cover, boardOnTop) {
            if (state.cover != "boot" && !boardOnTop) park.requestFocus()
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
            if (state.sceneVisible) 0f else 1f, tween(BACKDROP_FADE_MS), label = "backdrop",
        )
        if (paper > 0f) PaperStage(Modifier.alpha(paper))

        Column(
            Modifier
                .fillMaxSize()
                // A TV's own overscan margin. The HUD deliberately takes none (it
                // is anchored to engine rects); a full-screen board does.
                .padding(horizontal = 96.dp, vertical = 54.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().weight(1f),
                horizontalArrangement = Arrangement.spacedBy(36.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.width(TICKET_WIDTH)) { JoinTicket(state) }
                Spacer(Modifier.weight(1f))
                // THE RACE RAIL IS A COLUMN, and its two cards go to opposite ends:
                // `.cup-slot { margin-bottom: auto }` pins the pick to the TOP and
                // leaves the shelf the floor. A `space-between` rail would park the
                // lone shelf at the top pre-pick and then drop it when the pick
                // arrived, which is the one movement the arrangement exists to stop.
                Column(
                    Modifier.width(RACE_RAIL_WIDTH).fillMaxHeight(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    // HIDDEN ENTIRELY pre-pick — not an empty card, not a
                    // placeholder. The model answers null until the host has picked,
                    // and an empty sticker would promise a card with nothing to say.
                    state.cupSlot?.let { CupCard(it, state.cups) }
                    Spacer(Modifier.weight(1f))
                    if (state.cups.isNotEmpty()) CupShelf(state.cups)
                }
            }
            SeatDock(state)
        }

        // THE INFO CORNER, and the only control on this board.
        //
        // It opens the legal branch (privacy, imprint, licenses), which is the one
        // thing a TV app owes its viewer that no phone in the room can show them.
        // Everything else here is still driven from the phones — see the note above
        // about the START button that is deliberately absent.
        //
        // TOP-LEFT, where tvOS puts it top-right, and that is this shell's one
        // deliberate difference: the perf readout takes the top-right corner here,
        // over every board (RootScreen), where tvOS keeps it out of the way at the
        // bottom. It is off until somebody asks for it now, so this is no longer a
        // collision a player would see — but "somebody asks for it" is a developer
        // reading the lobby, and putting a black diagnostic block over the only
        // control on the board is worst exactly then.
        //
        // UNLIT UNTIL ASKED FOR, which is the park above's whole job: Compose
        // seats focus somewhere the moment the window takes it, so without a
        // second stop to absorb that this badge is what opens lit. It brightens
        // when a viewer actually presses Up, and the room reads the join code off
        // an unlit board until then.
        InfoBadge(Modifier.align(Alignment.TopStart).padding(start = 16.dp, top = 12.dp)) {
            state.infoPath = listOf(GameState.InfoRoute.Info)
        }
    }
}

/**
 * The ⓘ: a round sticker badge with a drawn "i" in it.
 *
 * DRAWN, not typed: the glyph is a dot over a stem, which is two primitives and
 * no dependency on a font having a legible dotted lowercase i at badge size — the
 * same call `StarRow` and `LockGlyph` make beside it.
 *
 * Focus is the kit's own: brighten, lift, deepen the drop. It is a small target
 * in a corner, so it takes the FULL blue face when focused rather than only the
 * lift — the same "you are here" blue every board in this branch wears.
 */
@Composable
private fun InfoBadge(modifier: Modifier = Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val diameter = 54.dp
    Box(
        modifier
            .size(diameter)
            .hardShadow(if (focused) Sticker.focusShadow else Sticker.popShadow, CircleShape)
            .background(if (focused) Tokens.blue else Tokens.surface, CircleShape)
            .stickerOutline(Sticker.border, CircleShape)
            .onFocusChanged { focused = it.isFocused }
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        val ink = if (focused) Color.White else Tokens.ink
        Canvas(Modifier.size(diameter)) {
            // A DrawScope is in PHYSICAL pixels — the density override buys the
            // layout tree its authored dp and buys a Canvas body nothing.
            val px = 1.dp.toPx()
            val cx = size.width / 2f
            drawCircle(ink, radius = 3.2f * px, center = Offset(cx, size.height * 0.31f))
            drawLine(
                ink,
                Offset(cx, size.height * 0.44f),
                Offset(cx, size.height * 0.74f),
                strokeWidth = 6.4f * px,
                cap = StrokeCap.Round,
            )
        }
    }
}

// -- (a) the join ticket ----------------------------------------------------

@Composable
private fun JoinTicket(state: GameState) {
    val open = state.joinUrl.isNotEmpty()
    StickerCard(rotation = -1.2f, padding = TICKET_PAD) {
        Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // The masthead's wordmark takes NO die-cut edge: a white cut on a white
            // card is invisible, which is what `.ticket__wordmark` zeroes the stroke
            // for.
            Wordmark(size = 38.dp, dieCut = false)

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
                            // `.ticket__cd` — the ACCENT, and the only part of the
                            // ticket that changes per party. In ink it read as a
                            // heading detached from any address.
                            StickerText(
                                state.roomCode, size = URL_SIZE * 1.45f,
                                color = Tokens.accent, tracking = 0.04f,
                            )
                        }
                    }
                }
            }

            // HELD BACK UNTIL THERE IS SOMETHING TO SCAN (`.ticket:has(#qr.is-in)
            // .tagline`): a board that says "scan the code" over a blank white
            // square is instructing the room to scan nothing. Its box stays
            // reserved, so the card does not resize when it appears.
            StickerText(
                Copy.scanPrompt, size = 18.dp,
                color = if (open) Tokens.ink2 else Color.Transparent,
                modifier = Modifier.widthIn(max = 380.dp),
            )
        }
    }
}

/**
 * The ticket's host line: what a person would TYPE, which is not what the QR
 * carries.
 *
 * `main.js` composes it as `new URL(joinUrl).host + pathname` and then splits the
 * room code off the tail so the accent line below can carry it. Printing
 * `state.joinUrl` verbatim instead puts the scheme, the `?cpp=androidtv` the
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
private fun CupCard(slot: GameState.CupSlot, cups: List<GameState.CupRow>) {
    // THE COUCH'S STARS FOR THIS PICK, merged SHELL-SIDE exactly as the web merges
    // them (`renderLobbyPick`'s `starsFor`) — stars are progression, not catalogue
    // data, so the frozen ui corpus's cupSlot answers stay untouched. Only a CUP
    // card wears them: the tour, random and exact-track cards all go bare.
    val stars = if (slot.nameKey == "cup" && slot.cupId != null) {
        cups.firstOrNull { it.id == slot.cupId }?.stars ?: 0
    } else null

    StickerCard(Modifier.fillMaxWidth(), rotation = 1.2f, padding = 16.dp) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            // THE CARD'S LOUDEST ELEMENT, and it has to be: this card exists to say
            // WHICH circuit. As plain ink text the headline was quieter than the
            // races caption under it.
            StickerBadge(cupName(slot))
            stars?.let { StarRow(it, size = 20.dp) }

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
            // the pick's markup before the meter. Above them, the card's two chrome
            // tokens stacked at the top and pushed the picture to the bottom.
            StickerPillOutlined(Copy.races(slot.racesKey, slot.raceCount), size = 15.dp)

            // null and 0 are different: null hides the whole meter, 0 draws four
            // unlit pips.
            slot.difficulty?.let { DifficultyMeter(it) }
        }
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
 */
private fun cupTint(cupId: String?): Color {
    val pct = Ttp.ttp_ui_cup_field_tint_pct().toDouble()
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
    val shape = RoundedCornerShape(Sticker.radiusSmall)
    // THREE cases, not two. A LOCKED rung is the tour's teaser: sunken PAPER under a
    // padlock, which shows the ladder without selling it as a race (the races pill
    // never counts it) — `--surface-2`, the warm cream, not a cold ink wash, or it
    // reads as a disabled control beside four warm siblings. An UNDRAWN race takes
    // its OWN cup's colour when the chip names one and the picker's cup-less
    // fallback when it does not — never the card's tint, because an unknown must not
    // borrow the drawn race's colour.
    val field = when {
        map.locked -> Tokens.surface2
        map.trackId == null -> cupTint(map.cup)
        else -> map.cup?.let { cupTint(it) } ?: cardTint ?: cupTint(null)
    }
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .background(field, shape)
            .stickerOutline(Sticker.hairlineBorder, shape),
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
        // `.cup-maps__n` — a badge hung OFF the tile's top-left corner, white on
        // solid ink. Printed in the tile's CENTRE it was standing where the map
        // belongs, which is how a card came to show a "1" instead of a circuit.
        if (map.n > 0) {
            Box(
                Modifier
                    .align(Alignment.TopStart)
                    .offset(x = (-6).dp, y = (-6).dp)
                    .background(Tokens.ink, RoundedCornerShape(percent = 50))
                    .padding(horizontal = 7.dp, vertical = 1.dp),
            ) {
                StickerText(map.n.toString(), size = 15.dp, weight = Fonts.semibold,
                    color = Color.White)
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
private fun CupShelf(cups: List<GameState.CupRow>) {
    Box(Modifier.fillMaxWidth()) {
        StickerCard(Modifier.fillMaxWidth(), rotation = -1f, padding = 12.dp) {
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
                            Box(
                                Modifier
                                    .size(13.dp)
                                    .background(cupDot(cup.id), CircleShape)
                            )
                        }
                        StickerText(
                            Copy.shortCup(cup.name), size = 21.dp,
                            color = if (cup.locked) Tokens.ink2 else Tokens.ink,
                            modifier = Modifier.weight(1f),
                        )
                        if (cup.locked) {
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
        // The `.pill` tab riding the card's top-left corner, drawn OVER it so the
        // card's own outline runs behind the label.
        Box(Modifier.align(Alignment.TopStart).offset(x = 14.dp, y = (-13).dp)) {
            StickerPill(Copy.cupsShelf, tint = Tokens.ink, size = 14.dp)
        }
    }
}

/** A shelf dot is the cup's colour at FULL strength — not the tiles' washed field. */
private fun cupDot(cupId: String): Color =
    Color(Ttp.ttp_ui_cup_tint_rgb(TtpJson.arg(cupId), 100.0) or 0xFF000000.toInt())

/** 0..4 pips. */
@Composable
private fun DifficultyMeter(level: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (i in 0 until 4) {
            Box(
                Modifier
                    .size(14.dp)
                    .background(if (i < level) Tokens.red else Tokens.surface2, CircleShape)
                    .stickerOutline(Sticker.hairlineBorder, CircleShape)
            )
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
            // the seat is still theirs to come back to.
            .alpha(if (seat.off) 0.5f else 1f)
            // Every other card leans; the tilt alternates so the dock reads as a
            // row of stickers rather than a table.
            .tilt(if (seat.index % 2 == 0) -1.4f else 1.4f),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                // AN OPEN SEAT KEEPS THE FULL FOOTPRINT and changes only its skin:
                // translucent white so the scene shows through, a DASHED 45%-ink
                // rule, and no drop at all. Drawn as a solid opaque card with the
                // full ink outline and a hard shadow, four empty seats read as a row
                // of buttons the viewer is meant to press.
                .then(
                    if (seat.open) Modifier.dashedOutline(
                        Sticker.border, Sticker.radius, Tokens.ink.copy(alpha = 0.45f))
                    else Modifier.hardShadow(Sticker.popShadow, shape)
                )
                .background(
                    if (seat.open) Color.White.copy(alpha = 0.5f) else Tokens.surface, shape)
                .then(
                    if (seat.open) Modifier else Modifier.stickerOutline(Sticker.border, shape))
                .padding(horizontal = 8.dp, vertical = 7.dp),
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
                // THE NAME CARRIES THE LIVERY (`.seat__name { color: var(--c) }`),
                // and its box reserves two lines however short the name is, so the
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
                        color = if (seat.open) Tokens.ink3 else Tokens.car(seat.colorIndex),
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
            when {
                seat.host -> HostStar(Modifier.align(Alignment.TopEnd).offset(x = 11.dp, y = (-14).dp))
                seat.ready -> ReadyCheck(Modifier.align(Alignment.TopEnd).offset(x = 9.dp, y = (-10).dp))
            }
        }
    }
}

/** `.seat__ready` — a green disc with a white tick and an ink ring. */
@Composable
private fun ReadyCheck(modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(26.dp)
            .background(Tokens.green, CircleShape)
            .stickerOutline(Sticker.hairlineBorder, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
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
}

/**
 * `.seat__host` — the gold star with an ink stroke.
 *
 * The one place a gold survives the chrome veto, and it survives it on the web
 * too: `#ffc83d` is a raw literal in `display.css`, not a token, precisely because
 * it is this mark and nothing else. Matching it is what keeps the two docks
 * comparable; inventing a fifth chrome colour for it would not.
 */
@Composable
private fun HostStar(modifier: Modifier = Modifier) {
    val gold = Color(0xFFFFC83D)
    val ink = Tokens.ink
    Canvas(modifier.size(31.dp)) {
        val p = androidx.core.graphics.PathParser.createPathFromPathData(
            "M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.1 6.47L12 17.9l-5.8 3.05 1.1-6.47-4.7-4.58 6.5-.95z"
        ).asComposePath()
        val s = size.minDimension / 24f
        drawContext.transform.scale(s, s, Offset.Zero)
        // `paint-order: stroke fill` — the ink runs UNDER the gold, so the stroke
        // reads as an outline around the star rather than as a rule across it.
        drawPath(p, ink, style = Stroke(width = 3.4f, join = StrokeJoin.Round))
        drawPath(p, gold)
    }
}

// -- the board's grid -------------------------------------------------------
//
// `#lobby` is a three-column grid whose MIDDLE CELL IS DELIBERATELY EMPTY — that
// gap is where the live track preview is seen, and it is why the two cards are
// rails rather than a centred stack. The two rail widths below are the CSS's,
// resolved at 1920x1080: `min(clamp(240px, 26vw, 440px), 38vh)` and
// `min(clamp(220px, 24vw, 460px), 32vh)`.
//
// Both rails' cards are `width: 100%` of their column, which is what makes the QR
// the lobby's main element rather than a small square inside a shrink-wrapped card.

private val TICKET_WIDTH = 410.dp
private val RACE_RAIL_WIDTH = 346.dp

/** `.ticket`'s `padding: 0.85rem` — a thin paper margin, so the QR fills the card. */
private val TICKET_PAD = 14.dp

/** `.ticket__urlbox`'s type scale; the room code is 1.45em of it. */
private val URL_SIZE = 17.dp

/** `.seat`'s `clamp(100px, 9.5vw, 134px)`, and `.seat__name`'s type scale. */
private val SEAT_WIDTH = 134.dp
private val SEAT_NAME_SIZE = 21.dp

/** `.cup-maps`' `gap: 7px`. */
private val MAP_GAP = 7.dp
