import SwiftUI

/// The info board: privacy, imprint and the way into the license list.
///
/// **THE TV IS NOT WHERE ANY OF THIS IS READ.** Privacy and imprint are
/// couchpad.games pages shared by every game on the launcher (they are not this
/// game's, and duplicating either here would be a second copy of a legal text
/// that has to stay correct), and an Apple TV has no browser to open them in.
/// So the board does what the lobby ticket already does with the join link: it
/// puts the URL on a card as a QR for the phone the player is holding, and
/// prints it underneath for anyone typing it.
///
/// Reached only from the lobby's ⓘ, and only by the remote — no phone can push
/// this board, and nothing in the game pushes it either. The Menu button pops
/// it, which is `NavigationStack`'s own behaviour and the platform's idiom, so
/// there is no on-screen back hint: what Menu is called differs across remote
/// generations, and naming it would be wrong for half the room.
///
/// The licenses list beneath it is the one part that IS meant to be read on the
/// screen, because it is the credit the licenses actually oblige us to show —
/// see `LicensesView`.
@MainActor
struct InfoView: View {

    /// Card metrics, as constants for the same reason `LobbyViewMetrics` is:
    /// tvOS is always 1920x1080 POINTS whatever the box outputs. `fileprivate`
    /// so the card below can size itself from them.
    fileprivate static let cardWidth: CGFloat = 380
    fileprivate static let cardPadding: CGFloat = 20

    var body: some View {
        PaperStage {
            VStack(spacing: 44) {
                Wordmark(size: 64)

                HStack(alignment: .top, spacing: 72) {
                    LegalCard(title: Copy.privacy, url: Legal.privacyURL)
                    LegalCard(title: Copy.imprint, url: Legal.imprintURL)
                }

                // The ONE focusable thing on this board, so the focus engine
                // seats the remote here on arrival with nothing to arbitrate —
                // which is also why it is drawn as the board's ACTION and not as
                // a quiet choice: a board with a single control has no louder
                // sibling for a quiet one to be quieter than, and a white choice
                // read as decoration beside two white cards. Blue, like the
                // cards' own labels.
                NavigationLink(value: GameState.InfoRoute.licenses) {
                    Text(Copy.licenses)
                }
                .buttonStyle(StickerButtonStyle(tint: Tokens.blue, size: 34))
                // Both for the same reasons `StickerButton` states: the system
                // focus slab is sized to the layout frame rather than the drawn
                // face and photographs as a dark rectangle behind the board, and
                // an unfixed tvOS button takes the whole width it is offered.
                .focusEffectDisabled()
                .fixedSize()
                .accessibilityIdentifier("licenses-link")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottom) { version }
        }
    }

    /// The shipping version, quiet at the foot of the board. It is the number a
    /// player reads back when something is wrong, and the only string here that
    /// needs no translation.
    @ViewBuilder
    private var version: some View {
        if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            Text(v)
                .font(Fonts.display(20, weight: .semibold))
                .foregroundStyle(Tokens.ink3)
                .padding(.bottom, 12)
        }
    }
}

/// One legal page as a paper card: its name as a label, the QR that opens it on
/// a phone, and the URL in full underneath.
///
/// Display-only, deliberately NOT focusable. There is nothing for the remote to
/// do to a QR code, and a focusable card would put two more stops between the
/// board arriving and the licenses button the remote actually wants.
@MainActor
private struct LegalCard: View {
    let title: String
    let url: String

    var body: some View {
        StickerCard(padding: InfoView.cardPadding) {
            VStack(spacing: 14) {
                StickerPill(title, tint: Tokens.blue, size: 22)
                qr
                // The scheme is noise to someone typing a URL off a television,
                // and the QR carries it regardless — the same trim the lobby
                // ticket makes on the join link.
                Text(url.replacingOccurrences(of: "https://", with: ""))
                    .font(Fonts.display(21, weight: .semibold))
                    .foregroundStyle(Tokens.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
        }
        .frame(width: InfoView.cardWidth)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title): \(url)")
    }

    /// Square whether or not Core Image produced anything, so a card that fails
    /// to encode still holds the layout rather than collapsing around its label.
    /// Filtered and antialiased for the same reason the lobby ticket's is: this
    /// is a downscale, where point sampling makes a code ragged rather than
    /// crisp (see `LobbyView.qrPanel`).
    @ViewBuilder
    private var qr: some View {
        let side = InfoView.cardWidth - 2 * InfoView.cardPadding
        if let code = QRCode.image(for: url) {
            Image(decorative: code, scale: 1)
                .interpolation(.high)
                .antialiased(true)
                .resizable()
                .frame(width: side, height: side)
        } else {
            Color.clear.frame(width: side, height: side)
        }
    }
}
