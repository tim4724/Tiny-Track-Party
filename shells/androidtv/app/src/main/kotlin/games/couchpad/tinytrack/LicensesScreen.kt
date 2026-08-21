package games.couchpad.tinytrack

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
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
 * and a television can follow neither, so a CC-BY or CC0 row used to name its
 * licence and give the room no way to read it. Which of the two texts a row has
 * behind it is the generator's business, not this file's.
 *
 * The rows are grouped exactly as the web page groups them (`SECTION_ORDER`),
 * and the ORDER inside a section is the shared data's own.
 */
@Composable
fun LicensesScreen(state: GameState) {
    LegalBoard(Copy.licenses) {
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
        // by the first layout pass by definition.
        val seat = remember { state.licensesList.firstVisibleItemIndex }
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            if (Legal.entries.isNotEmpty()) runCatching { first.requestFocus() }
        }

        LazyColumn(
            Modifier.fillMaxSize(),
            state = state.licensesList,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            // Room for the focused row's heavier edge and its hard shadow: both sit
            // OUTSIDE the row's own box, and a lazy list clips at its bounds.
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 4.dp, end = 14.dp, top = 8.dp, bottom = 8.dp),
        ) {
            itemsIndexed(Legal.entries, key = { _, e -> e.section + "/" + e.title }) { i, entry ->
                Column {
                    if (i == 0 || Legal.entries[i - 1].section != entry.section) {
                        Spacer(Modifier.height(if (i == 0) 0.dp else 18.dp))
                        StickerPill(entry.section, tint = Tokens.purple, size = 20.dp)
                        Spacer(Modifier.height(12.dp))
                    }
                    LicenseRow(
                        entry,
                        modifier = if (i == seat) Modifier.focusRequester(first) else Modifier,
                    ) { state.infoPath = state.infoPath + GameState.InfoRoute.License(i) }
                }
            }
        }
    }
}

/**
 * One credit: what it is and who made it on the left, what it is licensed under
 * on the right — the same two columns the web page's `.entry` row has.
 *
 * **FOCUS FILLS THE ROW BLUE**, and it has to go that far. The kit's every other
 * control says focus by lifting and brightening, and neither is available here: a
 * row is as wide as the list, so `Sticker.focusScale` pushes it past the list's
 * bounds, WHICH CLIP, and brightening a white sticker on warm paper does nothing
 * you can see from a sofa. So the row swaps face and type together, the way the
 * lobby's ⓘ does when the remote lands on it: blue is what "you are here" looks
 * like across this whole info branch, it is a chrome colour the theme allows, and
 * it needs no room the row does not already have.
 *
 * Every row opens, because every entry has a text behind it. It used to branch
 * on `notice`, leaving CC0 and CC-BY rows focusable but inert; what that cost was
 * not the press, it was that the majority of this list was terms the room could
 * not read.
 */
@Composable
private fun LicenseRow(
    entry: Legal.Entry,
    modifier: Modifier = Modifier,
    onOpen: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(Sticker.radius)

    Row(
        modifier
            // `hardShadow` FIRST, so the drop lands behind the face rather than
            // stamped on top of it (draw modifiers run in chain order).
            .fillMaxWidth()
            .hardShadow(if (focused) Sticker.focusShadow else Sticker.popShadow, shape)
            .background(if (focused) Tokens.blue else Tokens.surface, shape)
            .stickerOutline(if (focused) Sticker.border else Sticker.hairlineBorder, shape)
            .onFocusChanged { focused = it.isFocused }
            // `clickable` IS focusable, so the row must not ALSO be
            // `focusable()` — that is two focus targets in one row, and the
            // d-pad stops on each of them.
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onOpen,
            )
            .padding(horizontal = 22.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            StickerText(
                entry.title,
                size = 26.dp,
                color = if (focused) Color.White else Tokens.ink,
            )
            StickerText(
                entry.author,
                size = 20.dp,
                weight = Fonts.semibold,
                // Not `ink-3` on blue: the quiet grey a white card wants is barely
                // there against it, and the author is half of what the attribution
                // actually says.
                color = if (focused) Color.White.copy(alpha = 0.85f) else Tokens.ink3,
            )
        }

        // The pill stays INK on both faces. It is the one token on the row that
        // means something specific (the licence), and a pill that recoloured with
        // the focus would read as part of the highlight.
        StickerPill(entry.license, tint = Tokens.ink, size = 17.dp)

        // The chevron says the row opens, which every row now does. Kept rather
        // than dropped: it is the only mark on the row that says a press does
        // anything at all.
        StickerText(
            "›",
            modifier = Modifier.width(18.dp),
            size = 28.dp,
            color = if (focused) Color.White else Tokens.ink3,
        )
    }
}

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
    LegalBoard(entry.title) {
        val text = remember(index) { Legal.text(entry) }
        if (text == null) {
            // The staged file is missing, which is a build fault (the generator
            // names only files it copied). Say so on the screen rather than showing
            // an empty board that reads as "no licence".
            StickerText(entry.licenseUrl, size = 24.dp, weight = Fonts.semibold, color = Tokens.ink3)
        } else {
            LicenseText(text)
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
        val page = with(androidx.compose.ui.platform.LocalDensity.current) {
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
        ) { Column(Modifier.fillMaxSize().verticalScroll(scroll)) {
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
 * The chrome both legal boards wear: paper, a title sticker, and the body under
 * it.
 *
 * Paper rather than floating over the live 3D, because these are full-screen
 * BOARDS in the project's own sense: chrome floats bare over the scene, boards
 * stand on paper.
 */
@Composable
private fun LegalBoard(title: String, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        PaperStage()
        Column(
            Modifier.fillMaxSize().padding(horizontal = 60.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            StickerBadge(title, tint = Tokens.red, size = 40.dp, rotation = -1.2f)
            content()
        }
    }
}
