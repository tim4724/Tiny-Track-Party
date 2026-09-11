import SwiftUI

/// The display's OWN relay link, over everything (the web's `#link-overlay`).
/// Driven by the `set-link` effect: RECONNECTING with the kit's attempt counter
/// while the backoff runs, DISCONNECTED once the budget is spent — and then,
/// unless the slot was taken over by another display, a RECONNECT that
/// `ttp_net_reconnect_json` answers.
///
/// The button takes focus when it appears: nothing else on the glass is
/// focusable in the gave-up state, so without this the remote could not reach
/// it. Same glass as the pause overlay, for the same reason: the two are one
/// surface at two moments.
struct LinkOverlay: View {
    let link: LinkView
    let onReconnect: () -> Void

    private enum Control: Hashable { case reconnect }
    @FocusState private var focus: Control?

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            Rectangle().fill(Tokens.paper.opacity(0.72)).ignoresSafeArea()

            StickerCard(tint: Tokens.surface, padding: 44) {
                VStack(spacing: 24) {
                    Text(link.state == "disconnected" ? Copy.disconnected : Copy.reconnecting)
                        .font(Fonts.display(54, weight: .bold))
                        .foregroundStyle(Tokens.ink)
                    // Attempt 0 is the heartbeat's unnumbered immediate retry:
                    // heading only, as on the web.
                    if link.state == "reconnecting" && link.attempt > 0 {
                        Text(Copy.attempt(link.attempt, of: link.max))
                            .font(Fonts.body(26))
                            .foregroundStyle(Tokens.ink.opacity(0.7))
                    }
                    if link.button {
                        StickerButton(Copy.reconnectLabel, tint: Tokens.brand,
                                      size: 30, action: onReconnect)
                            .focused($focus, equals: .reconnect)
                    }
                }
            }
        }
        .defaultFocus($focus, .reconnect)
    }
}
