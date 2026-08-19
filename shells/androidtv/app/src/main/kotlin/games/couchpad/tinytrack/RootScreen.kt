package games.couchpad.tinytrack

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * The screen switcher: put whichever board the model names over the 3D surface.
 *
 * Two jobs and no third: stand the boards up, and route. **It owns no game
 * logic.** Every action is a call into the coordinator, and every decision behind
 * those calls is already `ttp_ui.h`'s or `ttp_race.h`'s — including what BACK
 * means, which is `ttp_ui_back_effect`'s answer and lives in [MainActivity]'s back
 * callback rather than as a switch here.
 *
 * THE 3D IS ALWAYS AT THE BOTTOM AND NEVER TORN DOWN. The shell does not hide the
 * surface; each BOARD decides whether its own opaque paper is in front. A shell
 * that stopped the frame loop to "hide" the scene would also stop the attract race
 * the lobby is showing.
 *
 * THERE IS NO WELCOME BOARD, and that is a platform difference rather than an
 * omission. The web's welcome exists to collect a user GESTURE — the one that
 * unlocks an AudioContext and enters fullscreen — and a TV has neither
 * restriction, so a title card with a single button would be a press between the
 * viewer and the room code for nothing. The tvOS shell reaches the same conclusion
 * and boots straight to the lobby.
 *
 * The crossfade is a conditional INSERTION, not an opacity ramp over views that
 * stay in the tree. On a TV that distinction is the whole ball game: a composable
 * at zero alpha is still focusable, so an invisible button would keep eating
 * remote presses from behind the board that replaced it.
 */
@Composable
fun RootScreen(game: GameCoordinator) {
    val state = game.state

    Box(Modifier.fillMaxSize()) {
        when (state.screen) {
            // Unreachable on this platform, and kept only because the screen enum
            // mirrors the model's rather than this shell's. Rendering the lobby
            // here too keeps the switch total without inventing a board.
            GameState.Screen.WELCOME, GameState.Screen.LOBBY -> LobbyScreen(state)
            GameState.Screen.RACE -> RaceHud(state)
        }

        // The overlays, in paint order. Each is a conditional insertion.
        // The banner's LAST text is held, because the exit fade is triggered BY the
        // countdown going null: composing `state.countdown` here would render nothing
        // for the whole 200 ms exit and "GO!" would vanish instantly instead of
        // fading. AnimatedVisibility keeps its content alive through the exit; it
        // cannot keep the value the content reads.
        var lastCount by remember { mutableStateOf("") }
        state.countdown?.let { lastCount = it }
        AnimatedVisibility(
            visible = state.screen == GameState.Screen.RACE && state.countdown != null,
            enter = fadeIn(tween(120)), exit = fadeOut(tween(200)),
        ) { CountdownBanner(lastCount) }

        if (state.results != null) ResultsScreen(state, game)

        // The CC-BY credit for the playing song, bottom-left of the race screen. A
        // LICENSING obligation, not decoration: the catalogue is Kevin MacLeod's
        // under CC-BY and a shell that plays it owes a visible credit. Do not hide
        // it to clean up the frame.
        //
        // Paint order matches the web's z-indexes: the credit sits OVER the results
        // board and UNDER the pause scrim. Placement is the web's own 16 authored px
        // from each edge, deliberately not the board overscan margin.
        state.musicCredit?.let { credit ->
            if (state.screen == GameState.Screen.RACE) {
                Box(
                    Modifier
                        .align(Alignment.BottomStart)
                        .padding(16.dp)
                        // `max-width: min(46vw, 24rem)` with an ellipsis: a long
                        // title otherwise runs across the bottom of the screen and
                        // under the next cell's steer bar.
                        .widthIn(max = 384.dp)
                        .hardShadow(Sticker.floatShadow, RoundedCornerShape(percent = 50))
                        .background(
                            // The web applies rgba(42,39,53,0.55) AND a whole-element
                            // opacity of 0.78, so the ink lands at ~0.43. Folded into
                            // the colour rather than applied as `Modifier.alpha`,
                            // which is a graphicsLayer with `clip = true` — it would
                            // cut the hard drop off at the chip's own bounds, and
                            // every sticker's drop lives outside them.
                            Tokens.ink.copy(alpha = 0.55f * 0.78f),
                            RoundedCornerShape(percent = 50),
                        )
                        .padding(horizontal = 14.dp, vertical = 6.dp)
                ) {
                    StickerText(
                        Copy.musicCredit(credit.title, credit.artist),
                        size = 14.dp,
                        color = Color.White.copy(alpha = 0.92f * 0.78f),
                        body = true,
                    )
                }
            }
        }

        if (state.screen == GameState.Screen.RACE && state.paused && state.results == null) {
            PauseOverlay(game)
        }

        // Over everything, including the results glass: a frame's cost is most
        // interesting exactly where a board is on top of the scene.
        Box(Modifier.align(Alignment.TopEnd)) { PerfOverlay() }

        // The one channel this app has for saying something went wrong. A TV has no
        // console and no devtools, and every failure path in this shell is silent by
        // construction — a missing material degrades quietly, a rejected scene build
        // leaves the previous frame up.
        state.lastError?.let { why ->
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(24.dp)
                    .background(Tokens.danger, RoundedCornerShape(Sticker.radiusSmall))
                    .padding(horizontal = 14.dp, vertical = 8.dp)
            ) {
                StickerText(why, size = 16.dp, color = Tokens.paper, maxLines = 2)
            }
        }
    }
}
