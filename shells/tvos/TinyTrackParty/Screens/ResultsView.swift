import SwiftUI

/// The results board, in its three dressings: a plain single-race board, a cup
/// intermission (points plus a "next up" footer), and the cup podium.
///
/// **Which dressing, which rows go on the steps, which go in the list, and what
/// each row's trailing cell says are `ttp_ui_results_view_json`'s answers**, off
/// the same board `ttp_ui_standings_json` puts on the wire to the phones. The TV
/// and the phones therefore cannot tell different stories. Everything below is
/// markup and copy tables.
///
/// The type is `RaceResultsView` rather than `ResultsView` because
/// `GameState.ResultsView` is the model's answer and a SwiftUI view of the same
/// name would shadow it at every use site in this file.
struct RaceResultsView: View {

    /// `GameState.results`.
    let view: GameState.ResultsView

    /// Seconds left on the intermission, re-READ from `ttp_ui_intermission_secs`
    /// every 500 ms by the coordinator. **Never counted down here**: a fresh
    /// ceil against the deadline cannot drift, and a local timer on a TV that
    /// throttles or stalls would tell the room a different number than the
    /// phones were given.
    let intermissionSecs: Int?

    /// Mid-cup: chain into the next race with no lobby step.
    let onNextRace: () -> Void
    /// End of the road: back to the lobby (which also cancels a cup).
    let onNewGame: () -> Void

    private enum Control: Hashable { case primary }
    @FocusState private var focus: Control?

    var body: some View {
        ZStack {
            // The same frosted glass as the pause overlay, one step more opaque
            // (`rgba(255, 246, 235, 0.92)`): the race is frozen behind it and
            // this board is what the room is looking at now. The GLASS reaches
            // the bezel; the board itself stays inside the TV's safe area.
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            Rectangle().fill(Tokens.paper.opacity(0.92)).ignoresSafeArea()

            VStack(spacing: 0) {
                title
                if view.intermission, let sub = view.sub {
                    Text(Copy.sub(sub.key, cupName: sub.cupName, race: sub.race, of: sub.of))
                        .font(Fonts.display(26, weight: .bold))
                        .foregroundStyle(Tokens.ink2)
                        .padding(.bottom, 21)
                }
                podium
                list
                nextUp
                primaryButton
            }
            .padding(.horizontal, 40)
        }
        // One control on the board, and it must be focused the moment the board
        // appears: a TV has no pointer, so an unfocused screen is a dead screen.
        .defaultFocus($focus, .primary)
    }

    // MARK: - Title

    private var title: some View {
        let text = Copy.title(view.titleKey, cupName: view.cupName)
        return Group {
            if view.podium {
                // Podium boards go full celebration: a RED header sticker, one
                // size down from the plain title so it does not dwarf the steps.
                // Red is the celebration colour in this design system — the
                // amber that used to be is vetoed in chrome.
                Text(text)
                    .font(Fonts.display(54, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.vertical, 14)
                    .padding(.horizontal, 38)
                    .background(
                        RoundedRectangle(cornerRadius: Sticker.radiusLarge, style: .continuous)
                            .fill(Tokens.red)
                            .hardShadow(Sticker.cardShadow)
                    )
                    .stickerOutline(Sticker.border, radius: Sticker.radiusLarge)
                    .rotationEffect(.degrees(-2))
                    .padding(.bottom, 30)
            } else {
                Text(text)
                    .font(Fonts.display(74, weight: .bold))
                    .foregroundStyle(Tokens.ink)
                    .padding(.bottom, 16)
            }
        }
    }

    // MARK: - The podium

    /// The top three on rising steps, arranged in VISUAL order 2 | 1 | 3 — the
    /// champion in the middle, which is what a podium looks like and not what
    /// the array order is.
    @ViewBuilder
    private var podium: some View {
        if !view.podiumRows.isEmpty {
            HStack(alignment: .bottom, spacing: 18) {
                // Fewer than three steps is normal, not a gap to pad: a
                // two-player cup has no third place, and the frozen slice can
                // shorten the steps further when a joining row lands inside the
                // top three.
                ForEach([2, 1, 3], id: \.self) { place in
                    if view.podiumRows.indices.contains(place - 1) {
                        PodiumColumn(place: place, row: view.podiumRows[place - 1])
                    }
                }
            }
            .padding(.bottom, 26)
        }
    }

    // MARK: - The list

    private var list: some View {
        VStack(spacing: 10) {
            ForEach(Array(view.listRows.enumerated()), id: \.element.id) { index, row in
                ResultRow(row: row, rank: rank(at: index))
            }
        }
        // A fixed column rather than the web's content-driven `min-width: 24rem`.
        // Each row holds a `Spacer` to push its trailing cell right, so a row
        // takes whatever width it is proposed — and the proposal here is the
        // whole 1920, which would stretch eight stickers across the screen.
        .frame(width: 860)
    }

    /// The rank numeral beside a list row.
    ///
    /// **THIS IS THE FROZEN SLICE, SEEN FROM THE SHELL — do not "fix" it.**
    /// `podiumRows` takes the top three NON-JOINING rows while `listRows` starts
    /// at index 3 of the RAW order, so on a podium board the list's first row
    /// really is the 4th finisher and the counter starts at 4. That is exactly
    /// what `display.css` does (`#results.is-podium #results-list {
    /// counter-reset: li 3 }`), and it is why a joining row inside the first
    /// three shortens the steps without shifting the list. A shell that
    /// "corrects" the asymmetry drops a racer off both.
    ///
    /// The number is the position because the model does not emit a place:
    /// `ttp_ui.cc`'s `rowValue` writes no such key, and `Row` deliberately
    /// declines to invent one (see its note in `GameState`).
    private func rank(at index: Int) -> Int {
        (view.podium ? 3 : 0) + index + 1
    }

    // MARK: - The intermission footer

    @ViewBuilder
    private var nextUp: some View {
        if view.intermission, let next = view.next {
            // "Next up: Gulch — starting in 8…", assembled from three literals
            // around two values exactly as the web assembles it, so the sentence
            // reads the same on both screens.
            (Text(Copy.nextUp)
                + Text(next.trackName).font(Fonts.display(24, weight: .bold)).foregroundColor(Tokens.ink)
                + Text(Copy.startingIn)
                + Text(intermissionSecs.map(String.init) ?? "")
                + Text(Copy.ellipsis))
                .font(Fonts.body(24, weight: .heavy))
                .foregroundStyle(Tokens.ink2)
                .padding(.top, 22)
        }
    }

    // MARK: - The one button

    /// Mid-cup this is "Next race ▸" and it chains the series; otherwise it is
    /// "New Game" and it ends the party back to the lobby.
    ///
    /// The LABEL and the ACTION come from the same key, which is the point of
    /// dispatching on it here: the web labels from `newGameKey` but acts off its
    /// own live `series` object, so those two can in principle disagree. They
    /// cannot here.
    private var primaryButton: some View {
        StickerButton(Copy.newGame(view.newGameKey), tint: Tokens.brand, size: 30) {
            if view.newGameKey == "next_race" { onNextRace() } else { onNewGame() }
        }
        .focused($focus, equals: .primary)
        .padding(.top, 29)
    }
}

// MARK: - A podium column

/// One step: the name over the banked points over a livery-coloured block
/// carrying the rank numeral. The champion's column pops in like the GO! banner.
private struct PodiumColumn: View {
    let place: Int
    let row: GameState.ResultsView.Row

    /// `.podium__step` heights: 6rem / 4rem / 2.9rem.
    private var stepHeight: CGFloat {
        switch place {
        case 1: return 96
        case 2: return 64
        default: return 47
        }
    }

    @State private var popped = false

    var body: some View {
        VStack(spacing: 9) {
            // AI keep their (CPU) tag on the podium as well as in the list.
            // Beating them is the story of a short-handed cup, so the tag is
            // never dropped to tidy a name up.
            Text(Copy.name(row.name, ai: row.ai))
                .font(Fonts.display(place == 1 ? 26 : 22, weight: .bold))
                .foregroundStyle(Tokens.car(row.colorIndex))
                .lineLimit(1)
            Text(Copy.points(row.points ?? 0))
                .font(Fonts.body(21, weight: .heavy))
                .foregroundStyle(Tokens.ink2)
                .monospacedDigit()
            ZStack {
                // Square-bottomed: the step stands ON the board, it is not a
                // floating sticker. `border-radius: r-sm r-sm 0 0`.
                UnevenRoundedRectangle(topLeadingRadius: Sticker.radiusSmall,
                                       bottomLeadingRadius: 0,
                                       bottomTrailingRadius: 0,
                                       topTrailingRadius: Sticker.radiusSmall,
                                       style: .continuous)
                    .fill(Tokens.car(row.colorIndex))
                    .hardShadow(Sticker.popShadow)
                    .overlay(
                        UnevenRoundedRectangle(topLeadingRadius: Sticker.radiusSmall,
                                               bottomLeadingRadius: 0,
                                               bottomTrailingRadius: 0,
                                               topTrailingRadius: Sticker.radiusSmall,
                                               style: .continuous)
                            .strokeBorder(Tokens.ink, lineWidth: Sticker.border)
                    )
                Text(String(place))
                    .font(Fonts.display(place == 3 ? 30 : 35, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 128, height: stepHeight)
        }
        .scaleEffect(place == 1 && !popped ? 0.4 : 1)
        .opacity(place == 1 && !popped ? 0 : 1)
        .animation(.spring(response: 0.45, dampingFraction: 0.5), value: popped)
        .onAppear { popped = true }
    }
}

// MARK: - A list row

/// `#results-list li` — rank numeral, name in the player's livery, and one
/// trailing cell.
private struct ResultRow: View {
    let row: GameState.ResultsView.Row
    let rank: Int

    var body: some View {
        HStack(spacing: 14) {
            // Late joiners ride along under the field with no rank number: they
            // did not race this one.
            Text(row.joining ? "\u{2013}" : String(rank))
                .font(Fonts.display(28, weight: .bold))
                .foregroundStyle(Tokens.ink2)
                .frame(minWidth: 34, alignment: .leading)
                .monospacedDigit()
            // Player-supplied text. It carries the livery colour itself — no
            // swatch dot, which is the same call the web makes for this list.
            Text(Copy.name(row.name, ai: row.ai))
                .font(Fonts.body(30, weight: .heavy))
                .foregroundStyle(Tokens.car(row.colorIndex))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 24)
            trailing
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 20)
        .background(
            RoundedRectangle(cornerRadius: Sticker.radiusSmall, style: .continuous)
                .fill(Tokens.surface)
                .hardShadow(Sticker.popShadow)
        )
        .stickerOutline(Sticker.border, radius: Sticker.radiusSmall)
    }

    /// The trailing cell: "Next race" for a joiner, the cup's points story on a
    /// cup board, the lap clock otherwise.
    ///
    /// **WHICH cell is the MODEL's word**: every `listRows` entry carries `kind`
    /// ("joining" | "points" | "time", `ui_model.cc`), and the web switches on
    /// it too (`main.js`). A nil `kind` falls to the time branch — only
    /// `listRows` carry the key, and those always do; re-deriving the branch
    /// from points/gained presence here would be a second spelling of the rule.
    @ViewBuilder
    private var trailing: some View {
        switch row.kind {
        case "joining":
            Text(Copy.nextRace)
                .font(Fonts.body(26, weight: .heavy).italic())
                .foregroundStyle(Tokens.ink2)
        case "points":
            HStack(spacing: 16) {
                // Cup boards tell the points story; the lap clock already had its
                // moment on the finish cards. Zero is still printed and styled
                // quiet, so the column never goes ragged.
                Text(Copy.gained(row.gained ?? 0))
                    .font(Fonts.body(26, weight: .heavy))
                    .foregroundStyle((row.gained ?? 0) > 0 ? Tokens.brand : Tokens.ink3)
                Text(Copy.points(row.points ?? 0))
                    .font(Fonts.body(26, weight: .heavy))
                    .foregroundStyle(Tokens.ink2)
                    .monospacedDigit()
                    .frame(minWidth: 96, alignment: .trailing)
            }
        default:
            // DNF is `finished == false` — the web's own test (`main.js`).
            // `rowValue` emits `finished` and a null `time` for a car that did
            // not finish, and sends no `dnf` key at all.
            Text(row.finished ? Copy.seconds(row.time ?? 0) : Copy.dnf)
                .font(Fonts.body(26, weight: .heavy))
                .foregroundStyle(Tokens.ink2)
                .monospacedDigit()
        }
    }
}
