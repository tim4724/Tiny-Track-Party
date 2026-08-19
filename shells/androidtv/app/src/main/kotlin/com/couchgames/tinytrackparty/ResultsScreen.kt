package com.couchgames.tinytrackparty

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The results board.
 *
 * **A CUP BOARD IS TWO PHASES, and a shell that paints only one has dropped the
 * cup's whole story** (`ttp_ui.h`). `raceRows` is who won the RACE, in finishing
 * order with lap times, and it holds for `racePhaseMs`; then it becomes
 * `listRows`, the cup table it rewrote, in standings order with points. Painting
 * only `listRows` states the delta and never shows the change.
 *
 * **NOTHING APPEARS, DISAPPEARS OR RESIZES ACROSS THE TWO.** The two kinds differ
 * by the trailing TOTAL alone, precisely so phase 2 fills a cell rather than
 * replacing one: the cells below have FIXED WIDTHS and the footer is reserved.
 * Otherwise every row changes size at the moment the board starts animating its
 * POSITION, and it re-flows under the re-sort — which reads as a glitch, not as a
 * ranking.
 *
 * Phase 2 accounts the points out ONE AT A TIME and re-ranks on the totals it is
 * now showing, so a row overtakes another AT the point that does it. Discreteness
 * is what makes that legible: interpolating the same totals continuously reaches
 * the same place, but every rank change lands mid-blur with nothing to attribute
 * it to. `pointsBefore` is on every points row so the total can climb rather than
 * jump, and **no shell subtracts `gained` for itself**.
 */
@Composable
fun ResultsScreen(state: GameState, game: GameCoordinator) {
    val results = state.results ?: return

    // A single-race board has one phase and opens already settled.
    var standings by remember(results) { mutableStateOf(!results.twoPhase) }
    // How many points each row has moved out of its "+N" and into its total.
    var accounted by remember(results) { mutableStateOf(0f) }

    LaunchedEffect(results) {
        if (!results.twoPhase) return@LaunchedEffect
        delay(results.racePhaseMs.toLong())
        standings = true
        // The beats are FRACTIONS of the model's phase-1 hold, proportional rather
        // than fixed because racePhaseMs is itself scaled off the intermission
        // budget — a fixed duration would leave the tally still running after the
        // next race had started.
        val most = results.listRows.maxOfOrNull { it.owed() } ?: 0
        if (most == 0) { accounted = 1f; return@LaunchedEffect }
        val tickMs = max(16.0, results.racePhaseMs * TICK_OF_PHASE)
        val runMs = most * tickMs
        // Driven from the CLOCK, not from accumulated nominal delays. `delay` is a
        // floor, so summing tickMs stretches the tally under a starved main thread
        // — on this GPU, exactly when the next circuit is meshing — and it can still
        // be counting when the intermission advances. Reading elapsed time lets a
        // starved frame skip ahead and land inside the budget, which is why the web
        // drives `k` off performance.now().
        val startedAt = SystemClock.uptimeMillis()
        while (true) {
            delay(tickMs.toLong())
            val elapsed = (SystemClock.uptimeMillis() - startedAt).toDouble()
            accounted = (elapsed / runMs).toFloat().coerceIn(0f, 1f)
            if (elapsed >= runMs) break
        }
        accounted = 1f
    }

    // The rows as they stand RIGHT NOW: phase 1 is the race's order untouched;
    // phase 2 is the cup table with each row's total part-way to what it banked,
    // re-sorted on the totals being shown.
    val rows: List<LiveRow> = if (!standings) {
        results.raceRows.map { LiveRow(it, it.pointsBefore ?: it.points) }
    } else {
        results.listRows
            .mapIndexed { seat, r ->
                val done = (accounted * r.owed()).roundToInt()
                LiveRow(r, (r.pointsBefore ?: 0) + done, seat = seat)
            }
            // Sorted on the total it is SHOWING, with the model's own final order as
            // the tie-break — which is what guarantees the last point lands the
            // board exactly on it.
            .sortedWith(compareByDescending<LiveRow> { it.total ?: -1 }.thenBy { it.seat })
    }

    // The title, the medals and the footer all wait for the last point. Crowning a
    // champion while rows can still overtake would mark the wrong one.
    val settled = standings && accounted >= 1f

    Box(
        // PAPER, not ink. `#results` is `rgba(255,246,235,0.92)` — warm paper is
        // exactly what a full-screen board is allowed (and the only place it is),
        // so scrimming with ink inverts the board's whole value.
        Modifier.fillMaxSize().background(Tokens.paper.copy(alpha = 0.92f)),
        contentAlignment = Alignment.Center,
    ) {
        // NO CARD. `#results` is a flex column on the paper wash and nothing else —
        // the title, the list and the button sit BARE on it, which is what lets the
        // white rows read as stickers laid on paper. A white panel behind them puts
        // white behind the elements that are themselves the white ones, and its
        // rotation leaned every row, the title and the button together (a row's top
        // edge fell 9 px across its own width) so the cells looked misaligned.
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
                // TWO TITLE STATES, and the podium's is the SMALLER of them, because
                // it wears a box: `#results h2` is 4.6rem (73.6 authored px) plain,
                // while `.is-champs h2` drops to 3.4rem (54.4) and reserves the
                // sticker's padding and a TRANSPARENT border from its first frame.
                // The celebration is then paint only — fill, border colour, shadow
                // and a rotation, none of which cost layout — so nothing under it
                // moves at the moment the rows are mid-flip. Recolouring the WORD
                // instead loses both the box and the size step.
                val champs = settled && results.podium
                val titleShape = RoundedCornerShape(Sticker.radiusLarge)
                Box(
                    Modifier
                        .then(if (champs) Modifier.tilt(-2f) else Modifier)
                        .then(if (champs) Modifier.hardShadow(Sticker.cardShadow, titleShape) else Modifier)
                        .background(if (champs) Tokens.red else Color.Transparent, titleShape)
                        // Reserved on every board, so the champs border lands as
                        // colour rather than as 4 dp of new layout.
                        .stickerOutline(
                            Sticker.border, titleShape,
                            color = if (champs) Tokens.ink else Color.Transparent,
                        )
                        .padding(horizontal = TITLE_SIZE * 0.7f, vertical = TITLE_SIZE * 0.25f),
                ) {
                    StickerText(
                        Copy.title(
                            if (settled) results.titleKey
                            else results.raceTitleKey.ifEmpty { results.titleKey },
                            results.cupName,
                        ),
                        size = if (results.podium) TITLE_SIZE else TITLE_SIZE_PLAIN,
                        color = if (champs) Color.White else Tokens.ink,
                    )
                }

                // HELD, not removed, once the cup board settles: the podium's CHAMPS
                // header says it all, and "Sunset - Race 4 of 4" under "Sunset
                // CHAMPS!" is the race still talking over the cup. `.is-held` is
                // `visibility: hidden` precisely so the box stays — dropping it
                // shrinks the column and re-centres everything, sliding the list and
                // the button up under a sticker that is supposed to be the only thing
                // arriving.
                results.sub?.let {
                    StickerText(
                        Copy.sub(it.key, it.cupName, it.race, it.of),
                        size = 24.dp,
                        color = if (settled && !results.intermission) Color.Transparent else Tokens.ink2,
                    )
                }

                // TWO COLUMNS above five rows. A full grid is eight (FIELD_SIZE) and
                // late joiners append one row each; at eleven a single unbounded
                // Column exceeds 1080 authored px, and Compose then measures the
                // trailing children — the ONLY BUTTON ON THE SCREEN — at maxHeight 0.
                // Invisible, still focusable, and the board is unusable. The web hit
                // exactly this and split at the same count.
                //
                // COLUMN-MAJOR, so ranks 1..ceil(n/2) fill the left column top-down
                // and the rest the right: the same reading order the phone's board
                // uses, so two screens rank alike.
                val perColumn = if (rows.size > ONE_COL_MAX) (rows.size + 1) / 2 else rows.size
                // ONE WIDTH PER KIND, decided by the board rather than by the row:
                // a single-race row has no cup columns at all (the model returns
                // before them), so it needs neither their width nor their gutter.
                val boardWidth =
                    if (results.twoPhase || results.podium) BOARD_WIDTH_CUP else BOARD_WIDTH_RACE
                Row(
                    Modifier.width(
                        if (rows.size > ONE_COL_MAX) boardWidth * 2 + COL_GAP else boardWidth),
                    horizontalArrangement = Arrangement.spacedBy(COL_GAP),
                ) {
                    for (col in 0 until (rows.size + perColumn - 1) / perColumn) {
                        val slice = rows.drop(col * perColumn).take(perColumn)
                        // A LazyColumn KEYED BY PLAYER, so a row that overtakes
                        // another GLIDES past it rather than the two swapping
                        // contents in place. The re-sort is the whole point of phase
                        // 2 — the rows re-ordering under the points that moved them
                        // is the only place a player can see what the race DID — and
                        // a swap with no movement reads as a re-render.
                        LazyColumn(
                            Modifier.width(boardWidth).height(rowsHeight(perColumn)),
                            verticalArrangement = Arrangement.spacedBy(ROW_GAP),
                            userScrollEnabled = false,
                        ) {
                            itemsIndexed(slice, key = { _, it -> it.row.id }) { i, live ->
                                BoardRow(col * perColumn + i + 1, live, settled, Modifier.animateItem())
                            }
                        }
                    }
                }

                // RESERVED, not conditional — but only on a board that is going to
                // GET a footer. The footer arrives with phase 2, and a board that
                // grows at the moment it re-sorts reads as a glitch; a single-race
                // board has no phase 2 and no next race, so reserving there is just
                // dead space over the button (`.results-next` is `display: none` on
                // a board that will never have one, and `visibility: hidden` only
                // while it has merely not arrived).
                //
                // `width(boardWidth)`, NOT fillMaxWidth. Inside a Column whose own
                // width is decided by its children, fillMaxWidth takes the INCOMING
                // MAX — the whole screen — and drags the board out to the bezels
                // with it. An explicit HEIGHT, not a same-sized Spacer: a 24 dp
                // StickerText's line box is taller than 24 dp, so a Spacer(24.dp)
                // reserves less than the text it stands in for.
                if (results.intermission) Box(
                    Modifier.width(boardWidth).height(FOOTER_HEIGHT).padding(top = 4.dp),
                    Alignment.Center,
                ) {
                    val next = results.next
                    if (next != null && settled) {
                        StickerText(
                            Copy.nextUp + next.trackName + Copy.startingIn +
                                (state.intermissionSecs ?: next.secs) + Copy.ellipsis,
                            size = 24.dp, color = Tokens.ink2,
                        )
                    }
                }

                // TAKE FOCUS. A TV has no pointer, so an unfocused screen is a
                // DEAD screen: nothing lifts, and the viewer's natural first press
                // — OK, not a direction — goes nowhere. Both tvOS twins use
                // `.defaultFocus` for this reason; nothing in this shell requested
                // focus at all, and these two are its only focusable controls.
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { focus.requestFocus() }
                // `#results-newgame { margin-top: 1.8rem }`, and `.btn`'s own scale
                // rather than StickerButton's welcome-board default — at 34 dp the
                // em-relative padding carried the whole box with it and the CTA
                // outweighed the board above it.
                Spacer(Modifier.height(13.dp))
                StickerButton(
                    Copy.newGame(results.newGameKey),
                    modifier = Modifier.focusRequester(focus),
                    tint = Tokens.green,
                    size = BUTTON_SIZE,
                ) {
                    // Mid-cup it advances the series; at the end it ends the party.
                    // WHICH of those is the model's answer, carried in the key —
                    // this shell does not re-derive it.
                    if (results.newGameKey == "next_race") game.advanceSeriesRace()
                    else game.returnToLobby()
                }
        }
    }
}

/** One point accounted for, per row, per tick — as a fraction of phase 1's hold. */
private const val TICK_OF_PHASE = 0.035

/**
 * The two title sizes, and which one a board takes is decided by whether it is a
 * PODIUM rather than by whether it has settled — `.is-champs` lands on the first
 * frame so the celebration costs no layout.
 *
 * `#results h2` clamps to 4.6rem and `.is-champs h2` to 3.4rem on a 1080p board.
 */
private val TITLE_SIZE_PLAIN = 74.dp
private val TITLE_SIZE = 54.dp

/** What this row still has to move out of its "+N" and into its total. */
private fun GameState.ResultsView.Row.owed(): Int =
    if (kind == "points" && points != null && pointsBefore != null)
        max(0, points - pointsBefore) else 0

/** A row as it stands right now: the model's record plus the total being SHOWN. */
private data class LiveRow(
    val row: GameState.ResultsView.Row,
    val total: Int?,
    val seat: Int = 0,
)

/**
 * The board's width. Every band inside it matches, so the column wraps to one
 * number.
 *
 * CONTENT-SIZED ON THE WEB (`#results-list` is `min-width: 24rem` over
 * shrink-wrapping grid columns), which lands a single-race row near 245 authored px
 * and a cup row near 410 — the trailing numbers sit a few characters after the
 * name. At 940 the name and the time were separated by a third of the screen, and
 * a full eight-row board went bezel to bezel. Fixed rather than measured, because
 * the two PHASES must not re-measure between them; one number per KIND is what
 * gives both properties at once.
 */
private val BOARD_WIDTH_RACE = 250.dp
private val BOARD_WIDTH_CUP = 410.dp

/** Up to this many rows the board stays one column; above it, two. */
private const val ONE_COL_MAX = 5

/** Between the two columns, and the reserved footer's height. */
private val COL_GAP = 24.dp
private val FOOTER_HEIGHT = 34.dp

/** One row's height, and the gap between two.
 *
 * `#results-list li` measures ~60 authored px: a 1.5rem line box, `0.7rem`
 * padding top and bottom, and a 3px border on each side. Fixed rather than
 * content-sized, so the BOARD cannot resize under a re-sort. */
private val ROW_HEIGHT = 60.dp
private val ROW_GAP = 8.dp

private fun rowsHeight(n: Int): Dp = ROW_HEIGHT * n + ROW_GAP * max(0, n - 1)

/**
 * One board row.
 *
 * The cells have FIXED WIDTHS. That is the whole reason the two phases can be the
 * same layout: `points` fills the trailing cell that `time_gain` left showing a
 * before-total, and nothing re-measures.
 *
 * Note what the model does NOT send and this therefore does not invent: no
 * `place` (rank is the row's POSITION) and no `dnf` (it is `finished == false`).
 */
@Composable
private fun BoardRow(rank: Int, live: LiveRow, settled: Boolean, modifier: Modifier = Modifier) {
    val row = live.row
    val shape = RoundedCornerShape(Sticker.radiusSmall)
    Row(
        modifier
            .fillMaxWidth()
            .height(ROW_HEIGHT)
            // hardShadow FIRST — draw modifiers run in chain order, so chained
            // after background it stamps the drop over the face (see
            // shells/androidtv/CLAUDE.md).
            .hardShadow(Sticker.popShadow, shape)
            .background(Tokens.surface, shape)
            .stickerOutline(Sticker.border, shape)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        // THE RANK CELL, which is also the medal's. Gold/silver/bronze is what a
        // medal wants and what the theme forbids (yellow and amber are vetoed in
        // chrome), so the ranking is carried by WEIGHT: the champion takes a filled
        // chip in --red, second and third one in --ink-2, both with white numerals.
        // The chip's box is reserved on every row, so nothing resizes when it lands.
        //
        // A JOINING row is ranked with a DASH. It raced nothing, and printing "9"
        // beside a seat that has no result ranks it against people who do.
        // ONE TYPE SIZE FOR THE WHOLE ROW. `#results-list` sets `1.5rem` and the
        // rank, the name, the time, the gain and the total all inherit it — the
        // cells differ by COLOUR and fixed WIDTH, nothing else. Five sizes gave the
        // row an internal hierarchy the design does not have, and made the trailing
        // numbers look like a footnote to the name rather than its result.
        val medal = if (settled) row.medal else null
        Box(Modifier.width(ROW_TYPE * 1.6f), contentAlignment = Alignment.CenterEnd) {
            Box(
                Modifier
                    // A PILL, not a disc. `li::before` is `min-width: 1.6em` with
                    // `0.05em 0.45em` of padding and a pill radius — a circle is
                    // what a fixed square becomes, and at the row's real height it
                    // grows into a token twice the web's.
                    .defaultMinSize(minWidth = ROW_TYPE * 1.6f)
                    .background(
                        when (medal) {
                            1 -> Tokens.red
                            2, 3 -> Tokens.ink2
                            else -> Color.Transparent
                        },
                        RoundedCornerShape(percent = 50),
                    )
                    .padding(horizontal = ROW_TYPE * 0.45f, vertical = ROW_TYPE * 0.05f),
                contentAlignment = Alignment.Center,
            ) {
                StickerText(
                    if (row.joining) "–" else rank.toString(),
                    size = ROW_TYPE,
                    color = if (medal != null) Color.White else Tokens.ink2,
                )
            }
        }
        // NO SWATCH. `#results-list .res-name { color: var(--c, var(--ink)) }` — the
        // livery rides the NAME, and `lobbySeats.js` says so in as many words ("the
        // name itself carries the livery colour — no dot"). A disc beside an ink
        // name moves the one colour on the row off the one word that identifies its
        // owner, and adds an object the design does not have.
        // THE BODY FACE, like the rest of the row. `#results-list` inherits
        // `body`'s Nunito and only the rank numeral opts into the display face
        // (`li::before` sets `font-family: var(--font-display)`), so a board set
        // entirely in Fredoka has rounder digits and terminals than the web's at
        // every cell but one.
        StickerText(
            Copy.name(row.name, row.ai),
            size = ROW_TYPE,
            color = Tokens.car(row.colorIndex),
            body = true,
            modifier = Modifier.weight(1f),
        )

        // A JOINING row carries NOTHING ELSE — the model returns early on it — so
        // every other cell here is its neutral value, by design.
        if (row.joining) {
            CellText(Copy.nextRace, ROW_TYPE * 8f, size = ROW_TYPE, color = Tokens.ink3)
        } else {
            // BOTH RACE COLUMNS RETIRE TOGETHER once the cup board settles. The
            // settled board is the CUP's — its rank is a cup rank and its total a
            // cup total — and a lap time left sitting between them is the one
            // number still talking about the race. It had the whole race phase to
            // be read in. Faded, never removed: the cells hold their width so
            // nothing re-measures under the re-sort.
            val spent = settled && row.kind == "points"
            CellText(
                // `time` is explicitly null for a car that did not finish, so null
                // IS the DNF signal — there is no separate flag.
                row.time?.let { Copy.seconds(it) } ?: Copy.dnf,
                ROW_TYPE * 3.6f, size = ROW_TYPE,
                color = when {
                    spent -> Color.Transparent
                    row.time == null -> Tokens.ink3
                    // `.res-time { color: var(--ink-2) }` — quieter than the name.
                    // At full ink the lap time competed with the one word on the
                    // row that says whose it is.
                    else -> Tokens.ink2
                },
            )
            // A TIME-ONLY row (a single race) has no cup columns at all — the model
            // returns before them. Laying them out anyway leaves ~184 authored px of
            // dead gutter down the right and narrows the name column by as much. The
            // fixed widths are load-bearing only BETWEEN THE TWO PHASES of a cup
            // board, where a single-race board has none.
            if (row.kind != "time") {
                // Zero is still printed ("+0") and styled quiet, so the column never
                // goes ragged — but ONLY zero. `.res-gain` is `--brand` green and
                // `.res-gain.is-zero` is the quiet `--ink-3`: the whole point of the
                // column is that the eye picks out who scored, and painting every
                // gain the quiet colour handed a "+9" the exact role the design
                // reserves for "+0".
                CellText(
                    row.gained?.let { Copy.gained(it) } ?: "",
                    ROW_TYPE * 1.8f, size = ROW_TYPE,
                    color = when {
                        spent -> Color.Transparent
                        (row.gained ?: 0) > 0 -> Tokens.brand
                        else -> Tokens.ink3
                    },
                )
                // FILLED IN BOTH PHASES and differing only in value: the race phase
                // shows what this row had coming in, the standings phase counts up to
                // what it banked. A total that merely APPEARED in phase 2 would have
                // no readable starting point for the climb.
                // `.res-pts { color: var(--ink-2) }`. Purple is the ITEMS role in
                // this palette and appears nowhere on the web's board — it made the
                // total the loudest thing in the row, which is backwards: the total
                // is data, and what the row is ABOUT is whose it is.
                CellText(
                    live.total?.let { Copy.points(it) } ?: "",
                    ROW_TYPE * 4.2f, size = ROW_TYPE, color = Tokens.ink2,
                )
            }
        }
    }
}

@Composable
private fun CellText(text: String, width: Dp, size: Dp, color: Color) {
    Box(Modifier.width(width), contentAlignment = Alignment.CenterEnd) {
        if (text.isNotEmpty()) StickerText(text, size = size, color = color, body = true)
    }
}

/**
 * `#results-list`'s ONE type size (`1.5rem`), inherited by every cell in a row.
 *
 * The rank, the name, the time, the gain and the total all take it, and the cells
 * differ by colour and fixed width alone. Five separate sizes gave the row an
 * internal hierarchy the design does not have.
 */
private val ROW_TYPE = 24.dp
