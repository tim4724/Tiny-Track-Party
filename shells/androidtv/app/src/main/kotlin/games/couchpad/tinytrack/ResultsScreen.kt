package games.couchpad.tinytrack

import android.os.SystemClock
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.ui.draw.alpha
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
import kotlin.math.min
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
    // The CUT's fade: the race table dips out and the cup's comes back in its
    // place. See the LaunchedEffect below.
    var listVisible by remember(results) { mutableStateOf(true) }
    val listAlpha by animateFloatAsState(
        if (listVisible) 1f else 0f,
        tween(((results.racePhaseMs * FADE_OF_PHASE).toInt()).coerceAtLeast(1)),
        label = "results-cut")

    // THE SETTLE STAMP IS THIS SHELL'S OWN BEAT. The phones are handed the board
    // the instant the race ends, which is the instant this screen STARTS its
    // reveal — `settled` is their cue to stop reporting the race and report the
    // cup, and sending it early crowns a champion on four phones while the TV is
    // still counting points towards one. The TIMING is necessarily here (it is
    // this reveal's own completion and no handle knows it); WHICH boards it means
    // anything for is the rule's, so [GameCoordinator.settleStandings] is armed on
    // every board that finishes settling and the model decides. A single-phase
    // board never settles, and neither does a reveal cancelled mid-flight — the
    // web's `raceOverlays.js` has both properties for the same reasons.
    //
    // ON THE MAIN THREAD, which this shell's rule 1 requires of every `ttp_*`
    // call: a LaunchedEffect runs on the composition's own AndroidUiDispatcher,
    // and `delay` resumes on it, so both call sites below are on main.
    LaunchedEffect(results) {
        if (!results.twoPhase) return@LaunchedEffect
        delay(results.racePhaseMs.toLong())

        // THE CUT. A cup board carries three orders — the race that just ended
        // (A), the cup BEFORE these points (B) and the cup after them (C) — and
        // re-sorting on the totals being shown means passing through B, which is
        // uncorrelated with the race just watched: the board snapped sideways
        // into the pre-race table before a single point had moved, with nothing
        // on screen to account for it. So A -> B is a CUT, not a move: the list
        // dips out, the heading turns over to "Standings", and the cup's own
        // table comes back in its place. Only B -> C is animated, and there
        // every row moves BECAUSE A POINT LANDED.
        val fadeMs = (results.racePhaseMs * FADE_OF_PHASE).toLong()
        listVisible = false
        delay(fadeMs)
        standings = true
        accounted = 0f
        listVisible = true
        delay(fadeMs)   // let the cup's table arrive before its numbers move

        // THE TALLY. A FIXED NUMBER OF BEATS, whatever the ladder pays: it used
        // to take one per point the WINNER owed, which tied the length of the
        // board to the top of POINTS_BY_RANK — widening that from 9 to 15
        // stretched it by two thirds with nothing here changing. A row still
        // moves WHOLE POINTS; it just moves as many as the clock has reached.
        val most = results.listRows.maxOfOrNull { it.owed() } ?: 0
        if (most == 0) { accounted = 1f; game.settleStandings(); return@LaunchedEffect }
        val tickMs = max(16.0, results.racePhaseMs * TICK_OF_PHASE)
        val runMs = TALLY_BEATS * tickMs
        // Driven from the CLOCK, not from accumulated nominal delays. `delay` is a
        // floor, so summing tickMs stretches the tally under a starved main thread
        // — on this GPU, exactly when the next circuit is meshing — and it can still
        // be counting when the intermission advances. Reading elapsed time lets a
        // starved frame skip ahead and land inside the budget, which is why the web
        // drives `k` off performance.now().
        val startedAt = SystemClock.uptimeMillis()
        while (true) {
            delay((tickMs / 4).toLong())
            val elapsed = (SystemClock.uptimeMillis() - startedAt).toDouble()
            // QUANTISED TO THE BEAT. Rows owe different amounts, so on a
            // continuous clock their totals cross a whole number at different
            // instants — and a row that gains one just before the row under it
            // does overtakes and is overtaken back inside a frame. Every total
            // moves on the same beat instead.
            val beat = min(TALLY_BEATS, (elapsed / tickMs).toInt())
            accounted = beat.toFloat() / TALLY_BEATS
            if (elapsed >= runMs) break
        }
        accounted = 1f
        // The cup is now told. Anything waiting on it — the phones — can say so.
        game.settleStandings()
    }

    // The rows as they stand RIGHT NOW: the race phase is the race's order and
    // states NO cup number at all; the standings phase is the cup table with each
    // row's total part-way to what it banked, re-sorted on the totals being shown.
    val rows: List<LiveRow> = if (!standings) {
        results.raceRows.map { LiveRow(it, null) }
    } else {
        results.listRows
            .mapIndexed { seat, r ->
                val done = (accounted * r.owed()).roundToInt()
                LiveRow(r, (r.pointsBefore ?: 0) + done, seat = seat)
            }
            // A TIE MOVES NOBODY until the very end. Breaking one by `seat` — the
            // FINAL order — makes a level score display the finish early: two rows
            // whose totals leapfrog tie on one beat, the lower jumps ahead because
            // it is going to end up there, and the next beat takes it back.
            // Mid-tally a tie keeps the order the rows came IN on; only the settled
            // board sorts on the model's, which is what lands it exactly there.
            .sortedWith(
                compareBy<LiveRow> { it.row.joining }
                    .thenByDescending { it.total ?: -1 }
                    .thenByDescending { if (accounted >= 1f) 0 else (it.row.pointsBefore ?: 0) }
                    .thenBy { it.seat })
    }

    // The title, the medals and the footer all wait for the last point. Crowning a
    // champion while rows can still overtake would mark the wrong one.
    val settled = standings && accounted >= 1f

    Box(
        // PAPER, not ink. `#results` is `rgba(255,246,235,0.92)` — warm paper is
        // exactly what a full-screen board is allowed (and the only place it is),
        // so scrimming with ink inverts the board's whole value. Flat, with no blur
        // behind it, by decision: at 0.92 only 8% of the frozen race gets through.
        // See `docs/native-port/shells.md`, "Decided, not owed".
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
                // ONE WIDTH, FULL STOP. Every row builds the same three trailing
                // cells whichever beat it is for, and a beat with nothing to say in
                // one leaves it EMPTY rather than leaving it out — so a race result,
                // a cup table and a podium are all the same size, here and on the web.
                val boardWidth = BOARD_WIDTH_CUP
                Row(
                    Modifier.alpha(listAlpha).width(
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
/** The cut's dip, as a fraction of the model's phase-1 hold. */
private const val FADE_OF_PHASE = 0.055
/** How many beats the tally takes, whatever the ladder pays. See the cut above. */
private const val TALLY_BEATS = 8

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
 * ONE ROW WIDTH FOR EVERY BOARD, sized by the name column and measured against
 * the web.
 *
 * Every beat builds the same three trailing cells and leaves the ones it has
 * nothing to say in EMPTY, so a race result, a cup table and a podium are all this
 * wide — there is no longer a number per KIND. A row is rank (1.6em) + gap + NAME
 * + gap + the three cells (3.6 + 2.7 + 4.2em with two gaps) + 12dp padding either
 * side; at the old 410 that left the name about 52dp and every eight-row cup board
 * truncated to "Th…", for as long as the board has had two columns. The web gives
 * the same 24dp type a ~147dp name column on a 502dp row. Fixed rather than
 * measured, because the beats must not re-measure between them.
 */
private val BOARD_WIDTH_CUP = 502.dp

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
            // WHICH CELL A BEAT SPEAKS IN is the row's KIND, and the cells it has
            // nothing to say in are still THERE, empty, holding their width:
            //   time_gain  the race:  the lap clock. Cup cells reserved.
            //   points     the cup:   the score and the total. Clock reserved.
            //   time       a single race: the clock, cup cells reserved too — it
            //              has no second beat of its own to line up with, so it
            //              lines up with the OTHER boards.
            //
            // THE ROW'S LAST NUMBER SITS AT THE RIGHT EDGE in both beats, which is
            // why the order differs: the standings end on the total, so the race
            // ends on the lap clock and keeps its two reserved cells to the LEFT of
            // it. A row whose one figure floated in the middle read as a column
            // that had lost its heading.
            val cup = row.kind == "points"
            // `time` is explicitly null for a car that did not finish, so null IS
            // the DNF signal — there is no separate flag. `.res-time` is --ink-2,
            // quieter than the name: at full ink it competed with the one word on
            // the row that says whose it is.
            val time = @Composable {
                CellText(
                    if (cup) "" else (row.time?.let { Copy.seconds(it) } ?: Copy.dnf),
                    ROW_TYPE * 3.6f, size = ROW_TYPE,
                    color = if (row.time == null) Tokens.ink3 else Tokens.ink2,
                )
            }
            // Zero is still printed ("+0") and styled quiet, so the column never
            // goes ragged — but ONLY zero. `.res-gain` is `--brand` green and
            // `.res-gain.is-zero` the quiet `--ink-3`: the point of the column is
            // that the eye picks out who scored, and painting every gain the quiet
            // colour handed a "+15" the exact role the design reserves for "+0".
            //
            // The width holds the WIDEST gain the ladder pays, not the settled "+0"
            // the tally ends on: this cell is a hard width, so a gain that outgrows
            // it clips rather than pushing the board wider. `.res-gain`'s min-width
            // in display.css carries the same number.
            //
            // It retires at settle — it would rest on "+0", reading as "scored
            // nothing". The lap clock needs no retiring: it went at the CUT.
            val gain = @Composable {
                CellText(
                    if (cup) row.gained?.let { Copy.gained(it) } ?: "" else "",
                    ROW_TYPE * 2.7f, size = ROW_TYPE,
                    color = when {
                        settled -> Color.Transparent
                        (row.gained ?: 0) > 0 -> Tokens.brand
                        else -> Tokens.ink3
                    },
                )
            }
            // On screen from the standings phase's FIRST frame, holding the value
            // the row came in with: a total that merely APPEARED in the beat that
            // changes it would have no readable starting point for the climb.
            // `.res-pts` is --ink-2. Purple is the ITEMS role in this palette and
            // appears nowhere on the web's board — it made the total the loudest
            // thing in the row, which is backwards: the total is data, and what the
            // row is ABOUT is whose it is.
            val pts = @Composable {
                CellText(
                    if (cup) live.total?.let { Copy.points(it) } ?: "" else "",
                    ROW_TYPE * 4.2f, size = ROW_TYPE, color = Tokens.ink2,
                )
            }
            if (cup) { time(); gain(); pts() } else { gain(); pts(); time() }
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
