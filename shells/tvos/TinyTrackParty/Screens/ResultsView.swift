import QuartzCore
import SwiftUI

/// The results board, in its three dressings: a plain single-race board, a cup
/// intermission (points plus a "next up" footer), and the cup podium.
///
/// **A CUP BOARD IS TWO PHASES, and a shell that paints only one of them has
/// dropped the cup's whole story** (`ttp_ui.h`). `raceRows` is who won the RACE,
/// in finishing order with lap times, and it holds for `racePhaseMs`; then it
/// becomes `listRows`, the cup table it rewrote, in standings order with points.
/// Painting only `listRows` states the delta and never shows the change.
///
/// **NOTHING APPEARS, DISAPPEARS OR RESIZES ACROSS THE TWO.** The two kinds
/// differ by the trailing TOTAL alone, precisely so phase 2 fills a cell rather
/// than replacing one: the cells below have FIXED WIDTHS and the footer is
/// reserved. Otherwise every row changes size at the moment the board starts
/// animating its POSITION, and it re-flows under the re-sort — which reads as a
/// glitch, not as a ranking.
///
/// Phase 2 accounts the points out ONE AT A TIME and re-ranks on the totals it
/// is now showing, so a row overtakes another AT the point that does it.
/// Discreteness is what makes that legible: interpolating the same totals
/// continuously reaches the same place, but every rank change lands mid-blur
/// with nothing to attribute it to. `pointsBefore` is on every points row so the
/// total can climb rather than jump, and **no shell subtracts `gained` for
/// itself**.
///
/// **There are no podium STEPS.** The cup's top three are medalled in place in
/// the standings list, and the rank counter runs 1..n over the whole board —
/// `listRows` IS the whole board, and there is no second slice to offset
/// against. A shell that lifts three rows onto steps is reading a key
/// `ttp_ui_results_view_json` does not answer.
///
/// **Which dressing, which rows, and what each row's cells say are
/// `ttp_ui_results_view_json`'s answers**, off the same board
/// `ttp_ui_standings_json` puts on the wire to the phones. The TV and the phones
/// therefore cannot tell different stories. Everything below is markup and copy
/// tables.
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

    /// Phase 2 is up. A single-race board has one phase and opens already there.
    @State private var standings = false
    /// How much of each row's "+N" has moved into its total, 0...1.
    @State private var accounted: Double = 0

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

            // NO CARD. `#results` is a flex column on the paper wash and nothing
            // else — the title, the list and the button sit BARE on it, which is
            // what lets the white rows read as stickers laid on paper.
            VStack(spacing: 16) {
                title
                sub
                board
                nextUp
                primaryButton
            }
        }
        // One control on the board, and it must be focused the moment the board
        // appears: a TV has no pointer, so an unfocused screen is a dead screen.
        .defaultFocus($focus, .primary)
        .task(id: view) { await runPhases() }
    }

    // MARK: - The two phases

    /// Hold phase 1, then account the points out against the CLOCK.
    ///
    /// Driven from elapsed time and not from accumulated nominal sleeps: a sleep
    /// is a floor, so summing `tickMs` stretches the tally under a starved main
    /// thread — on this box, exactly when the next circuit is meshing — and it
    /// can still be counting when the intermission advances. Reading elapsed
    /// time lets a starved frame skip ahead and land inside the budget, which is
    /// why the web drives its `k` off `performance.now()`.
    private func runPhases() async {
        standings = !view.twoPhase
        accounted = view.twoPhase ? 0 : 1
        guard view.twoPhase else { return }

        guard await sleep(ms: view.racePhaseMs) else { return }
        withAnimation(.easeInOut(duration: 0.35)) { standings = true }

        // The beats are FRACTIONS of the model's phase-1 hold, proportional
        // rather than fixed because racePhaseMs is itself scaled off the
        // intermission budget — a fixed duration would leave the tally still
        // running after the next race had started.
        let most = view.listRows.map(\.owed).max() ?? 0
        guard most > 0 else { accounted = 1; return }
        let tickMs = max(16.0, view.racePhaseMs * Self.tickOfPhase)
        let runMs = Double(most) * tickMs
        let startedAt = CACurrentMediaTime()
        while true {
            guard await sleep(ms: tickMs) else { return }
            let elapsed = (CACurrentMediaTime() - startedAt) * 1000
            withAnimation(.easeInOut(duration: 0.2)) {
                accounted = min(1, elapsed / runMs)
            }
            if elapsed >= runMs { break }
        }
        accounted = 1
    }

    /// `Task.sleep`, answering whether it completed rather than throwing — a
    /// cancelled sleep means the board was replaced and there is nothing left to
    /// drive.
    private func sleep(ms: Double) async -> Bool {
        do {
            try await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000))
            return true
        } catch {
            return false
        }
    }

    /// The title, the medals and the footer all wait for the last point.
    /// Crowning a champion while rows can still overtake would mark the wrong one.
    private var settled: Bool { standings && accounted >= 1 }

    /// The rows as they stand RIGHT NOW: phase 1 is the race's order untouched;
    /// phase 2 is the cup table with each row's total part-way to what it banked,
    /// re-sorted on the totals being shown.
    private var rows: [LiveRow] {
        guard standings else {
            return view.raceRows.map { LiveRow(row: $0, total: $0.pointsBefore ?? $0.points, seat: 0) }
        }
        return view.listRows.enumerated()
            .map { seat, r in
                let done = Int((accounted * Double(r.owed)).rounded())
                return LiveRow(row: r, total: (r.pointsBefore ?? 0) + done, seat: seat)
            }
            // Sorted on the total it is SHOWING, with the model's own final order
            // as the tie-break — which is what guarantees the last point lands
            // the board exactly on it.
            .sorted { a, b in
                let ta = a.total ?? -1, tb = b.total ?? -1
                return ta == tb ? a.seat < b.seat : ta > tb
            }
    }

    // MARK: - Title

    /// TWO TITLE STATES, and the podium's is the SMALLER of them, because it
    /// wears a box: `#results h2` is 4.6rem (73.6 authored px) plain, while
    /// `.is-champs h2` drops to 3.4rem (54.4) and reserves the sticker's padding
    /// and a TRANSPARENT border from its first frame. The celebration is then
    /// paint only — fill, border colour, shadow and a rotation, none of which
    /// cost layout — so nothing under it moves while the rows are mid-flip.
    private var title: some View {
        let champs = settled && view.podium
        let key = settled ? view.titleKey : (view.raceTitleKey.isEmpty ? view.titleKey : view.raceTitleKey)
        let size = view.podium ? Self.titleSize : Self.titleSizePlain
        return Text(Copy.title(key, cupName: view.cupName))
            .font(Fonts.display(size, weight: .bold))
            .foregroundStyle(champs ? Color.white : Tokens.ink)
            .padding(.vertical, Self.titleSize * 0.25)
            .padding(.horizontal, Self.titleSize * 0.7)
            .background(
                RoundedRectangle(cornerRadius: Sticker.radiusLarge, style: .continuous)
                    .fill(champs ? Tokens.red : Color.clear)
                    .hardShadow(champs ? Sticker.cardShadow : .zero)
            )
            // Reserved on every board, so the champs border lands as colour
            // rather than as 4 points of new layout.
            .stickerOutline(Sticker.border, radius: Sticker.radiusLarge,
                            color: champs ? Tokens.ink : Color.clear)
            .rotationEffect(.degrees(champs ? -2 : 0))
            .animation(.spring(response: 0.42, dampingFraction: 0.55), value: champs)
    }

    /// HELD, not removed, once the cup board settles: the podium's CHAMPS header
    /// says it all, and "Sunset - Race 4 of 4" under "Sunset CHAMPS!" is the race
    /// still talking over the cup. Hidden rather than dropped precisely so the
    /// box stays — removing it shrinks the column and re-centres everything,
    /// sliding the list and the button up under a sticker that is supposed to be
    /// the only thing arriving.
    @ViewBuilder
    private var sub: some View {
        if let sub = view.sub {
            Text(Copy.sub(sub.key, cupName: sub.cupName, race: sub.race, of: sub.of))
                .font(Fonts.display(24, weight: .bold))
                .foregroundStyle(settled && !view.intermission ? Color.clear : Tokens.ink2)
        }
    }

    // MARK: - The board

    /// TWO COLUMNS above five rows. A full grid is eight and late joiners append
    /// one row each; a single unbounded column then runs off a 1080-point screen
    /// and takes the only button with it. The web splits at the same count.
    ///
    /// COLUMN-MAJOR, so ranks 1...ceil(n/2) fill the left column top-down and the
    /// rest the right: the same reading order the phone's board uses, so two
    /// screens rank alike.
    private var board: some View {
        let live = rows
        let perColumn = live.count > Self.oneColumnMax ? (live.count + 1) / 2 : live.count
        // ONE WIDTH PER KIND, decided by the board rather than by the row: a
        // single-race row has no cup columns at all (the model returns before
        // them), so it needs neither their width nor their gutter.
        let width = (view.twoPhase || view.podium) ? Self.boardWidthCup : Self.boardWidthRace
        let columns = perColumn > 0 ? (live.count + perColumn - 1) / perColumn : 0
        return HStack(alignment: .top, spacing: Self.columnGap) {
            ForEach(Array(0..<columns), id: \.self) { col in
                VStack(spacing: Self.rowGap) {
                    ForEach(Array(live.dropFirst(col * perColumn).prefix(perColumn).enumerated()),
                            id: \.element.row.id) { i, entry in
                        BoardRow(rank: col * perColumn + i + 1, live: entry, settled: settled)
                    }
                }
                .frame(width: width, alignment: .top)
            }
        }
        // KEYED BY PLAYER above, so a row that overtakes another moves past it
        // rather than the two swapping contents in place. The re-sort is the
        // whole point of phase 2 — the rows re-ordering under the points that
        // moved them is the only place a player can see what the race DID.
        .frame(height: Self.rowsHeight(perColumn), alignment: .top)
    }

    // MARK: - The intermission footer

    /// RESERVED, not conditional — but only on a board that is going to GET a
    /// footer. The footer arrives with phase 2, and a board that grows at the
    /// moment it re-sorts reads as a glitch; a single-race board has no phase 2
    /// and no next race, so reserving there would be dead space over the button.
    @ViewBuilder
    private var nextUp: some View {
        if view.intermission {
            ZStack {
                if let next = view.next, settled {
                    // "Next up: Gulch — starting in 8…", assembled from three
                    // literals around two values exactly as the web assembles
                    // it, so the sentence reads the same on both screens.
                    (Text(Copy.nextUp)
                        + Text(next.trackName).font(Fonts.display(24, weight: .bold)).foregroundColor(Tokens.ink)
                        + Text(Copy.startingIn)
                        + Text(String(intermissionSecs ?? next.secs))
                        + Text(Copy.ellipsis))
                        .font(Fonts.body(24, weight: .heavy))
                        .foregroundStyle(Tokens.ink2)
                }
            }
            .frame(height: Self.footerHeight)
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
        .padding(.top, 13)
    }

    // MARK: - Geometry

    /// One point accounted for, per row, per tick — as a fraction of phase 1's
    /// hold, floored below at one frame. Both numbers are the WEB's
    /// (`raceOverlays.js`); `tests/shell-parity.test.js` fails if this copy or
    /// Android's drifts from it, which is the substitute for the `pointTickMs`
    /// the model does not answer.
    private static let tickOfPhase = 0.035

    /// `#results h2` (4.6rem) and `.is-champs h2` (3.4rem) on a 1080p board.
    private static let titleSizePlain: CGFloat = 74
    private static let titleSize: CGFloat = 54

    /// The board's width, one number per KIND.
    ///
    /// CONTENT-SIZED ON THE WEB (`#results-list` is `min-width: 24rem` over
    /// shrink-wrapping grid columns), which lands a single-race row near 245
    /// authored px and a cup row near 410. Fixed rather than measured, because
    /// the two PHASES must not re-measure between them.
    private static let boardWidthRace: CGFloat = 250
    private static let boardWidthCup: CGFloat = 410

    /// Up to this many rows the board stays one column; above it, two.
    private static let oneColumnMax = 5
    /// Between the two columns, and the reserved footer's height.
    private static let columnGap: CGFloat = 24
    private static let footerHeight: CGFloat = 34
    /// One row's height and the gap between two. `#results-list li` measures ~60
    /// authored px. Fixed rather than content-sized, so the BOARD cannot resize
    /// under a re-sort.
    fileprivate static let rowHeight: CGFloat = 60
    private static let rowGap: CGFloat = 8

    fileprivate static func rowsHeight(_ n: Int) -> CGFloat {
        rowHeight * CGFloat(n) + rowGap * CGFloat(max(0, n - 1))
    }
}

// MARK: - A row as it stands right now

/// The model's record plus the total being SHOWN, and where the model's own
/// final order put it (the re-sort's tie-break).
private struct LiveRow {
    let row: GameState.ResultsView.Row
    let total: Int?
    let seat: Int
}

private extension GameState.ResultsView.Row {
    /// What this row still has to move out of its "+N" and into its total.
    var owed: Int {
        guard kind == "points", let points, let pointsBefore else { return 0 }
        return max(0, points - pointsBefore)
    }
}

// MARK: - A board row

/// `#results-list li` — the medal/rank chip, the name in the player's livery,
/// and the trailing cells.
///
/// The cells have FIXED WIDTHS. That is the whole reason the two phases can be
/// the same layout: `points` fills the trailing cell that `time_gain` left
/// showing a before-total, and nothing re-measures.
///
/// Note what the model does NOT send and this therefore does not invent: no
/// `place` (rank is the row's POSITION) and no `dnf` (it is `finished == false`).
///
/// ONE TYPE SIZE FOR THE WHOLE ROW. `#results-list` sets `1.5rem` and the rank,
/// the name, the time, the gain and the total all inherit it — the cells differ
/// by COLOUR and fixed WIDTH, nothing else.
private struct BoardRow: View {
    let rank: Int
    let live: LiveRow
    let settled: Bool

    private var row: GameState.ResultsView.Row { live.row }

    /// `#results-list`'s one type size (`1.5rem`).
    private static let type: CGFloat = 24

    var body: some View {
        HStack(spacing: 11) {
            // THE RANK CELL, which is also the medal's. Gold/silver/bronze is
            // what a medal wants and what the theme forbids (yellow and amber
            // are vetoed in chrome), so the ranking is carried by WEIGHT: the
            // champion takes a filled chip in --red, second and third one in
            // --ink-2, both with white numerals. The chip's box is reserved on
            // every row, so nothing resizes when it lands.
            //
            // A JOINING row is ranked with a DASH. It raced nothing, and
            // printing "9" beside a seat that has no result ranks it against
            // people who do.
            rankChip
            // NO SWATCH. The livery rides the NAME — a disc beside an ink name
            // moves the one colour on the row off the one word that identifies
            // its owner. THE BODY FACE, like the rest of the row: only the rank
            // numeral opts into the display face.
            Text(Copy.name(row.name, ai: row.ai))
                .font(Fonts.body(Self.type, weight: .heavy))
                .foregroundStyle(Tokens.car(row.colorIndex))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .frame(height: RaceResultsView.rowHeight)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: Sticker.radiusSmall, style: .continuous)
                .fill(Tokens.surface)
                .hardShadow(Sticker.popShadow)
        )
        .stickerOutline(Sticker.border, radius: Sticker.radiusSmall)
    }

    private var medal: Int? { settled ? row.medal : nil }

    private var rankChip: some View {
        // A PILL, not a disc: `li::before` is `min-width: 1.6em` with
        // `0.05em 0.45em` of padding and a pill radius.
        Text(row.joining ? "\u{2013}" : String(rank))
            .font(Fonts.display(Self.type, weight: .bold))
            .foregroundStyle(medal == nil ? Tokens.ink2 : .white)
            .monospacedDigit()
            .padding(.horizontal, Self.type * 0.45)
            .padding(.vertical, Self.type * 0.05)
            .frame(minWidth: Self.type * 1.6)
            .background(
                Capsule().fill(medal == 1 ? Tokens.red : (medal == nil ? Color.clear : Tokens.ink2))
            )
            // The cell is a FIXED `1.6em` box (the pill's own min-width), so a
            // two-digit rank cannot widen it and steal the name's column — the
            // one cell here whose content is player-supplied.
            .frame(width: Self.type * 1.6, alignment: .trailing)
    }

    /// A JOINING row carries NOTHING ELSE — the model returns early on it — so
    /// every other cell here is its neutral value, by design.
    @ViewBuilder
    private var trailing: some View {
        if row.joining {
            cell(Copy.nextRace, width: Self.type * 8, color: Tokens.ink3)
        } else {
            // BOTH RACE COLUMNS RETIRE TOGETHER once the cup board settles. The
            // settled board is the CUP's — its rank is a cup rank and its total
            // a cup total — and a lap time left sitting between them is the one
            // number still talking about the race. Faded, never removed: the
            // cells hold their width so nothing re-measures under the re-sort.
            let spent = settled && row.kind == "points"
            cell(row.finished ? Copy.seconds(row.time ?? 0) : Copy.dnf,
                 width: Self.type * 3.6,
                 color: spent ? Color.clear : (row.finished ? Tokens.ink2 : Tokens.ink3))
            // A TIME-ONLY row (a single race) has no cup columns at all — the
            // model returns before them. Laying them out anyway leaves dead
            // gutter down the right and narrows the name column by as much.
            if row.kind != "time" {
                // Zero is still printed ("+0") and styled quiet, so the column
                // never goes ragged — but ONLY zero: the whole point of the
                // column is that the eye picks out who scored.
                cell(Copy.gained(row.gained ?? 0),
                     width: Self.type * 1.8,
                     color: spent ? Color.clear : ((row.gained ?? 0) > 0 ? Tokens.brand : Tokens.ink3))
                // FILLED IN BOTH PHASES and differing only in value: the race
                // phase shows what this row had coming in, the standings phase
                // counts up to what it banked. A total that merely APPEARED in
                // phase 2 would have no readable starting point for the climb.
                cell(live.total.map(Copy.points) ?? "",
                     width: Self.type * 4.2, color: Tokens.ink2)
            }
        }
    }

    private func cell(_ text: String, width: CGFloat, color: Color) -> some View {
        Text(text)
            .font(Fonts.body(Self.type, weight: .heavy))
            .foregroundStyle(color)
            .monospacedDigit()
            .lineLimit(1)
            .frame(width: width, alignment: .trailing)
    }
}
