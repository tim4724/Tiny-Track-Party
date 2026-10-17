package games.couchpad.tinytrack

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * The attribution list, and the license texts it drills into.
 *
 * **This board is an obligation, not a courtesy** — see [Legal] for who demands
 * what, and for why not one row of it is typed.
 *
 * **EVERY ROW OPENS.** A browser gets a link on each licence chip — the served
 * notice where one is shipped, else the canonical URL (`public/licenses.js`) —
 * and a television can follow neither, so every row opens a text here instead.
 * Which of the two texts a row has behind it is the generator's business, not
 * this file's.
 *
 * The rows are grouped exactly as the web page groups them (`SECTION_ORDER`),
 * and the ORDER inside a section is the shared data's own.
 */
@Composable
fun LicensesScreen(state: GameState) {
    LegalBoard {
        // Every row is focusable, including the ones with no text to drill into.
        // That is not decoration: `Modifier.focusable` brings itself into view, so
        // an unfocusable row is a row the REMOTE CANNOT REACH — and the music
        // (which needs no text) leads the list, so display-only rows would strand
        // everything below them.
        //
        // TAKE FOCUS on arrival, so the list is live without a press. Requested on
        // a ROW rather than on the LazyColumn: the column itself is not a focus
        // target, and a d-pad press into an unfocused list is a press that does
        // nothing.
        //
        // ON THE TOP VISIBLE ROW, which is row 0 on the way in and wherever the
        // viewer left off on the way back out of a license text (the scroll
        // position outlives this composable — see `GameState.licensesList`).
        // Asking for a row that is not on screen would ask a FocusRequester no
        // node is attached to yet, which throws; the top visible one is composed
        // by the first layout pass by definition. Item 0 is the title, so row k is
        // item k + 1.
        val seat = remember { (state.licensesList.firstVisibleItemIndex - 1).coerceAtLeast(0) }
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            if (Legal.entries.isNotEmpty()) runCatching { first.requestFocus() }
        }
        // Which row holds focus, because the rules either side of it hide: the
        // focused row's wash is its own shape, and a hairline running into it
        // reads as a seam.
        var focusedRow by remember { mutableStateOf(-1) }
        val entries = Legal.entries
        // The sections in order of first appearance, for the label colour cycle.
        val sections = remember { entries.map { it.section }.distinct() }

        // ONE PAPER CARD PER SECTION, and still one lazy item per ROW: a row has
        // to stay its own item so the list brings the FOCUSED ROW into view (a
        // card-sized item would scroll whole sections at a time). So each row
        // paints its slice of its section's card — the top slice carries the
        // label and the top corners, the bottom slice the bottom corners — and
        // the gap between two cards is the first slice's own top margin.
        //
        // THE TITLE IS THE FIRST ITEM, so it scrolls away with the page and the
        // cards run on to both edges of the screen rather than being cut off in a
        // hard line one inset in. The inset is the list's content padding, so
        // the first and last lines can still be brought clear of it.
        LazyColumn(
            Modifier.fillMaxSize(),
            state = state.licensesList,
            contentPadding = PaddingValues(top = Tokens.legalInsetY, bottom = Tokens.legalInsetY),
        ) {
            item(key = "title") { LegalTitle(Copy.licenses, Modifier.padding(bottom = TITLE_GAP)) }
            itemsIndexed(entries, key = { _, e -> e.section + "/" + e.title }) { i, entry ->
                val top = i == 0 || entries[i - 1].section != entry.section
                val bottom = i == entries.size - 1 || entries[i + 1].section != entry.section
                val r = Sticker.radiusLarge
                Column(
                    Modifier
                        .padding(top = if (top && i > 0) CARD_GAP else 0.dp)
                        .background(Tokens.surface, RoundedCornerShape(
                            topStart = if (top) r else 0.dp, topEnd = if (top) r else 0.dp,
                            bottomStart = if (bottom) r else 0.dp, bottomEnd = if (bottom) r else 0.dp,
                        ))
                        .padding(horizontal = CARD_PAD_X)
                        .padding(top = if (top) CARD_PAD_Y else 0.dp,
                            bottom = if (bottom) CARD_PAD_Y else 0.dp),
                ) {
                    if (top) {
                        // The section's LABEL in its colour, cycling red, blue,
                        // purple, green by section, as `.sec:nth-child(4n+k)` does
                        // on /licenses.html.
                        LabelPill(
                            entry.section, size = 16.5.dp, tracking = 0.08f,
                            tint = sectionColor(sections.indexOf(entry.section)),
                            modifier = Modifier.padding(start = 9.dp, top = 6.dp, bottom = 12.dp),
                        )
                    }
                    LicenseRow(
                        entry,
                        ruled = !top && focusedRow != i && focusedRow != i - 1,
                        modifier = (if (i == seat) Modifier.focusRequester(first) else Modifier)
                            .onFocusChanged {
                                if (it.isFocused) focusedRow = i
                                else if (focusedRow == i) focusedRow = -1
                            },
                    ) { state.infoPath = state.infoPath + GameState.InfoRoute.License(i) }
                }
            }
        }
    }
}

/** The section labels' colour cycle (`.sec:nth-child(4n+k)` in licenses.css). */
private fun sectionColor(index: Int) = when (index % 4) {
    0 -> Tokens.red
    1 -> Tokens.blue
    2 -> Tokens.purple
    else -> Tokens.green
}

/** A section card's padding and the air between two cards. */
private val CARD_PAD_X = 21.dp
private val CARD_PAD_Y = 18.dp
private val CARD_GAP = 24.dp

/**
 * One credit, on ONE LINE of its section's card: what it is and who made it on
 * the left, what it is licensed under on the right — the web page's `.entry` row.
 * Rows are parted by a hairline over each ([ruled]), not drawn as cards.
 *
 * **FOCUS WASHES IT `--pick` AND RINGS IT BLUE**, the picked look, and the ring is
 * drawn INSIDE the row rather than outside it as the kit's [focusRing]: a row is
 * as wide as the list, and a lazy list clips at its bounds. Blue is what "you are
 * here" looks like across this whole info branch.
 */
@Composable
private fun LicenseRow(
    entry: Legal.Entry,
    ruled: Boolean,
    modifier: Modifier = Modifier,
    onOpen: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(FOCUS_RADIUS)
    val hairline = Tokens.hairline

    Row(
        modifier
            .fillMaxWidth()
            .then(if (ruled) Modifier.drawBehind {
                drawRect(hairline, size = Size(size.width, 2.dp.toPx()))
            } else Modifier)
            .then(
                if (focused) Modifier
                    .background(Tokens.pick, shape)
                    .border(Sticker.focusRingWidth, Tokens.blue, shape)
                else Modifier
            )
            .onFocusChanged { focused = it.isFocused }
            // `clickable` IS focusable, so the row must not ALSO be
            // `focusable()` — that is two focus targets in one row, and the
            // d-pad stops on each of them.
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onOpen,
            )
            .padding(horizontal = 21.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(15.dp),
    ) {
        // Title then author on one baseline; a title too long for the line
        // ellipsises and the author keeps its place beside it.
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(15.dp)) {
            StickerText(entry.title, size = 24.dp, weight = Fonts.semibold, color = Tokens.ink,
                modifier = Modifier.alignByBaseline().weight(1f, fill = false))
            // ink-2, not ink-3: the author is half of what the attribution
            // actually says, and the quiet grey nearly vanishes on the pick wash.
            StickerText(entry.author, size = 19.5.dp, weight = Fonts.bold, color = Tokens.ink2,
                body = true, modifier = Modifier.alignByBaseline())
        }

        // A GREY LABEL on both faces. It is the one token on the row that means
        // something specific (the licence), and a label that recoloured with the
        // focus would read as part of the highlight.
        LabelPill(entry.license, size = 15.dp, tracking = 0.08f)

        // The only mark on the row that says a press opens it. Drawn, so its
        // weight matches the type.
        val ink3 = Tokens.ink3
        Canvas(Modifier.size(width = 13.5.dp, height = 21.dp)) {
            val u = size.width / 9f
            val p = Path().apply {
                moveTo(2f * u, 2f * u); lineTo(7f * u, 7f * u); lineTo(2f * u, 12f * u)
            }
            drawPath(p, ink3, style = Stroke(2.4f * u, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

/** The focused row's wash, a step inside the card's own `--r-lg` corner. */
private val FOCUS_RADIUS = 21.dp

/**
 * One license text, full screen and scrolling on its own.
 *
 * A license is only a notice while it is INTACT, so the text is shown verbatim,
 * in a monospace face at the pitch it was hard-wrapped for. Nothing here
 * reflows, truncates or paraphrases it.
 */
@Composable
fun LicenseTextScreen(index: Int) {
    val entry = Legal.entries.getOrNull(index) ?: return
    LegalBoard {
        // The title stays put here: the text scrolls by itself under it, and a
        // reader paging through a licence keeps the name of what they are reading.
        Column(
            Modifier.padding(top = Tokens.legalInsetY),
            verticalArrangement = Arrangement.spacedBy(TITLE_GAP),
        ) {
            LegalTitle(entry.title)
            val text = remember(index) { Legal.text(entry) }
            if (text == null) {
                // The staged file is missing, which is a build fault (the generator
                // names only files it copied). Say so on the screen rather than
                // showing an empty board that reads as "no licence".
                StickerText(entry.licenseUrl, size = 24.dp, weight = Fonts.semibold, color = Tokens.ink3)
            } else {
                LicenseText(text)
            }
        }
    }
}

/**
 * The text, scrolled by the d-pad a half-page at a time.
 *
 * **THE KEYS ARE HANDLED HERE BECAUSE NOTHING ELSE WILL.** `verticalScroll` is
 * driven by drags and by the focus system bringing a child into view, and this
 * page has neither — it is one unbroken block of text with no focusable inside
 * it, on a device with no pointer. So the VIEWPORT takes focus and turns Up/Down
 * into a scroll. (tvOS cannot do this at all: a tvOS ScrollView moves only to
 * reveal a focused view, which is why the Swift twin slices the text into
 * invisible focus stops. This platform has the simpler answer, so it takes it.)
 *
 * **THE FOCUS AND THE SCROLL MUST BE TWO NODES, and putting them on one is an
 * ANR.** `Modifier.focusable` asks its nearest scrollable ancestor to bring its
 * own bounds into view when it takes focus — so a chain of
 * `verticalScroll(...).focusable()` asks a scroll container to reveal ITSELF,
 * content taller than the viewport and all, and the resulting scroll/relayout
 * never settles. It does not crash and it logs nothing about scrolling: the
 * process is killed with `ANR ... Force finishing activity` a beat after Select,
 * having drawn nothing. The focusable is the outer Box (the viewport, whose own
 * parent does not scroll) and `verticalScroll` is the Column inside it.
 *
 * A HALF PAGE per press, so the reader keeps a few lines of context across the
 * jump, and animated so it reads as movement rather than as a new screen.
 */
@Composable
private fun LicenseText(text: String) {
    val scroll = rememberScrollState()
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val page = with(LocalDensity.current) {
            maxHeight.toPx() * 0.5f
        }
        Box(
            Modifier
                .fillMaxSize()
                .focusRequester(focus)
                .focusable()
                .onPreviewKeyEvent { e ->
                    // KeyDown only: a press delivers both an up and a down, and
                    // scrolling on each moves twice per press.
                    if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    val by = when (e.key) {
                        Key.DirectionDown -> page
                        Key.DirectionUp -> -page
                        else -> return@onPreviewKeyEvent false
                    }
                    scope.launch { scroll.animateScrollBy(by) }
                    true
                }
        ) { Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(bottom = Tokens.legalInsetY)) {
            // MONOSPACE AT 26, not the sticker face: display faces are unreadable
            // at license length, and these texts are hard-wrapped for a fixed
            // pitch — a proportional face makes their ragged right edge look like
            // damage. This is the one string in the app that is not [StickerText].
            BasicText(
                text = text,
                style = TextStyle(
                    color = Tokens.ink,
                    fontSize = 26.sp,
                    fontFamily = FontFamily.Monospace,
                    platformStyle = PlatformTextStyle(includeFontPadding = false),
                ),
            )
        } }
    }
}

/**
 * The paper both legal boards stand on, with tvOS's system safe area
 * (`Tokens.legalInsetX`) at the sides and nothing more. SwiftUI gives the tvOS
 * twin that area for free; Compose has no such floor, so without it the list
 * would sit in the overscan band and the two columns of the screens gallery
 * would disagree about where a board starts.
 *
 * NOT AT THE TOP OR THE FOOT: a body runs on to the screen's edges and scrolls
 * out under them, as a page does, rather than being cut off in a hard line one
 * inset in. Each body takes the vertical inset itself.
 *
 * Paper rather than floating over the live 3D, because these are full-screen
 * BOARDS in the project's own sense: chrome floats bare over the scene, boards
 * stand on paper.
 */
@Composable
private fun LegalBoard(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        PaperStage()
        Box(Modifier.fillMaxSize().padding(horizontal = Tokens.legalInsetX)) { content() }
    }
}

/** A legal board's heading: plain ink, top-left (`/licenses.html`'s `h1`). */
@Composable
private fun LegalTitle(title: String, modifier: Modifier = Modifier) {
    StickerText(title, size = 60.dp, modifier = modifier.lineBox(60.dp))
}

/** Between a legal board's title and its body. */
private val TITLE_GAP = 30.dp
