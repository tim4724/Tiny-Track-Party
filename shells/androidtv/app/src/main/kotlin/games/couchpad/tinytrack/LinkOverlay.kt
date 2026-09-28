package games.couchpad.tinytrack

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp

/**
 * The display's OWN relay link, over everything (the web's `#link-overlay`).
 * Driven by the `set-link` effect: RECONNECTING with the kit's attempt counter
 * while the backoff runs, DISCONNECTED once the budget is spent — and then,
 * unless the slot was taken over by another display, a RECONNECT that
 * `ttp_net_reconnect_json` answers.
 *
 * Same glass as [PauseOverlay], for the same reason: the two are one surface at
 * two moments. The button takes focus when it appears: nothing else on the glass
 * is focusable in the gave-up state, so without this the D-pad could not reach it.
 */
@Composable
fun LinkOverlay(link: GameState.LinkView, game: GameCoordinator) {
    Box(
        Modifier.fillMaxSize().background(Tokens.paper.copy(alpha = 0.72f)),
        contentAlignment = Alignment.Center,
    ) {
        StickerCard(rotation = 0f, padding = 48.dp) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                StickerText(
                    if (link.state == "disconnected") Copy.disconnected else Copy.reconnecting,
                    size = 54.dp,
                )
                // Attempt 0 is the heartbeat's unnumbered immediate retry: heading
                // only, as on the web.
                if (link.state == "reconnecting" && link.attempt > 0) {
                    StickerText(
                        Copy.attempt(link.attempt, link.max),
                        size = 26.dp,
                        color = Tokens.ink.copy(alpha = 0.7f),
                    )
                }
                if (link.button) {
                    val focus = remember { FocusRequester() }
                    LaunchedEffect(Unit) { focus.requestFocus() }
                    StickerButton(
                        Copy.reconnectLabel,
                        modifier = Modifier.focusRequester(focus)
                            .defaultMinSize(minWidth = BUTTON_MIN_WIDTH),
                        tint = Tokens.green,
                        size = BUTTON_SIZE,
                    ) { game.reconnectLink() }
                }
            }
        }
    }
}
