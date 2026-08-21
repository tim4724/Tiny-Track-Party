package games.couchpad.tinytrack

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.LaunchedEffect

/**
 * The info board: privacy, imprint and the way into the license list.
 *
 * **THE TV IS NOT WHERE ANY OF THIS IS READ.** Privacy and imprint are
 * couchpad.games pages shared by every game on the launcher (they are not this
 * game's, and duplicating either here would be a second copy of a legal text
 * that has to stay correct), and an Android TV box has no browser to open them
 * in. So the board does what the lobby ticket already does with the join link: it
 * puts the URL on a card as a QR for the phone the player is holding, and prints
 * it underneath for anyone typing it.
 *
 * Reached only from the lobby's ⓘ, and only by the remote — no phone can push
 * this board, and nothing in the game pushes it either. BACK pops it
 * ([MainActivity]'s callback), which is this platform's idiom, so there is no
 * on-screen back hint.
 *
 * The licenses list beneath it is the one part that IS meant to be read on the
 * screen, because it is the credit the licenses actually oblige us to show — see
 * [LicensesScreen].
 */
@Composable
fun InfoScreen(state: GameState) {
    // Card metrics, as constants for the same reason the lobby's are: under the
    // root's density override one dp is one authored pixel, so these are the
    // tvOS numbers unchanged.
    val cardWidth: Dp = 380.dp
    val cardPadding: Dp = 20.dp

    Box(Modifier.fillMaxSize()) {
        // OPAQUE PAPER, because this is a full-screen BOARD in the project's own
        // sense: chrome floats bare over the live 3D, boards stand on paper. The
        // attract race keeps running underneath and is simply not seen.
        PaperStage()

        Column(
            Modifier.fillMaxSize().padding(horizontal = 96.dp, vertical = 54.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Wordmark(size = 64.dp)
            Spacer(Modifier.height(44.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(72.dp)) {
                LegalCard(Copy.privacy, Legal.privacyUrl, -1.4f, cardWidth, cardPadding)
                LegalCard(Copy.imprint, Legal.imprintUrl, 1.4f, cardWidth, cardPadding)
            }
            Spacer(Modifier.height(44.dp))

            // THE ONE FOCUSABLE THING ON THIS BOARD, so it takes focus on arrival
            // and the viewer's natural first press — OK, not a direction — goes
            // somewhere. Drawn as a PRIMARY and not as the kit's quiet ghost: a
            // board with a single control has no louder sibling for a quiet one to
            // be quieter than, and a white ghost reads as decoration beside two
            // white cards. Blue, like the ⓘ that opened this board and the cards'
            // own labels.
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            StickerButton(
                Copy.licenses,
                modifier = Modifier.focusRequester(focus),
                tint = Tokens.blue,
                size = 30.dp,
            ) { state.infoPath = state.infoPath + GameState.InfoRoute.Licenses }
        }

        // The shipping version, quiet at the foot of the board. It is the number a
        // player reads back when something is wrong, and the only string here that
        // needs no translation. It carries the build's short sha (see
        // app/build.gradle.kts), which is what makes "which build is on the box?"
        // answerable from the sofa rather than over adb.
        StickerText(
            BuildConfig.VERSION_NAME,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
            size = 20.dp,
            weight = Fonts.semibold,
            color = Tokens.ink3,
        )
    }
}

/**
 * One legal page as a sticker card: its name, the QR that opens it on a phone,
 * and the URL in full underneath.
 *
 * Display-only, deliberately NOT focusable. There is nothing for the remote to do
 * to a QR code, and a focusable card would put two more stops between the board
 * arriving and the licenses button the remote actually wants.
 */
@Composable
private fun LegalCard(title: String, url: String, rotation: Float, width: Dp, padding: Dp) {
    StickerCard(Modifier.width(width), rotation = rotation, padding = padding) {
        Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            StickerPill(title, tint = Tokens.blue, size = 22.dp)

            // Square whether or not ZXing produced anything, so a card that fails
            // to encode still holds the layout rather than collapsing around its
            // label. Remembered on the URL: this is an 800 px bitmap and the board
            // recomposes with the focus.
            val qr = remember(url) { QRCode.bitmap(url) }
            Box(Modifier.fillMaxWidth().aspectRatio(1f)) {
                qr?.let {
                    Image(
                        bitmap = it.asImageBitmap(),
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        // Filtered for the reason the lobby ticket's is: this is a
                        // heavy downscale, and point-sampling one thins and merges
                        // modules in a way no decoder can recover.
                        filterQuality = FilterQuality.High,
                        contentScale = ContentScale.Fit,
                    )
                }
            }

            // The scheme is noise to someone typing a URL off a television, and
            // the QR carries it regardless — the same trim the lobby ticket makes
            // on the join link.
            StickerText(
                url.removePrefix("https://"),
                size = 21.dp,
                weight = Fonts.semibold,
                color = Tokens.ink,
            )
        }
    }
}
