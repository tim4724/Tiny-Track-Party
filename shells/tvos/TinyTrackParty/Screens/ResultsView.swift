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

    /// The last point has landed and the board has stopped moving.
    ///
    /// **The phones need it, and this shell never sent it.** They are handed the
    /// standings the instant the race ends, which is the instant this board
    /// STARTS its reveal, so anything they say about the cup before now would be
    /// said ahead of the TV. The TIMING is necessarily a shell's — it is this
    /// reveal's own completion and no handle knows it — while WHICH boards it
    /// means anything for is the rule's (`ttp_ui_settle_standings`: only a cup's
    /// LAST). So this fires on every board that finishes settling and the model
    /// decides. It is deliberately NOT called on a cancelled reveal: a board
    /// torn down mid-flight never settled. The web twin is `raceOverlays.js`'s
    /// `onSettled`.
    let onSettled: () -> Void

    /// Phase 2 is up. A single-race board has one phase and opens already there.
    @State private var standings = false
    /// How much of each row's "+N" has moved into its total, 0...1.
    @State private var accounted: Double = 0
    /// The CUT's fade. The race table dips out and the cup's comes back in its
    /// place — see runPhases.
    @State private var listOpacity: Double = 1

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

    /// THE CUP ANSWERS IN THREE BEATS: the race, then the cup as it stood before
    /// this race, then the points landing and the rows moving because of them.
    ///
    /// A cup board carries three orders — the race that just ended (A), the cup
    /// BEFORE these points (B) and the cup after them (C) — and re-sorting on
    /// the totals being shown means passing through B, which is uncorrelated
    /// with the race just watched. The board snapped sideways into the pre-race
    /// table before a single point had moved, with nothing on screen to account
    /// for it. So A -> B is a CUT: the list dips out, the heading turns over to
    /// "Standings", and the cup's own table comes back in its place. Nothing
    /// travels, so nothing has to be justified. Only B -> C is animated, and
    /// there every row moves BECAUSE A POINT LANDED.
    ///
    /// The tally is driven from elapsed time and not from accumulated nominal
    /// sleeps: a sleep is a floor, so summing `tickMs` stretches it under a
    /// starved main thread — on this box, exactly when the next circuit is
    /// meshing — and it can still be counting when the intermission advances.
    private func runPhases() async {
        standings = !view.twoPhase
        accounted = view.twoPhase ? 0 : 1
        listOpacity = 1
        // A single-phase board never settles, exactly as on the web: `settle()`
        // there is reachable only from phase 2.
        guard view.twoPhase else { return }

        guard await sleep(ms: view.racePhaseMs) else { return }

        // THE CUT.
        let fadeMs = view.racePhaseMs * Self.fadeOfPhase
        withAnimation(.easeIn(duration: fadeMs / 1000)) { listOpacity = 0 }
        guard await sleep(ms: fadeMs) else { return }
        standings = true
        accounted = 0
        withAnimation(.easeOut(duration: fadeMs / 1000)) { listOpacity = 1 }
        // Let the cup's table finish arriving before its numbers start moving.
        guard await sleep(ms: fadeMs) else { return }

        // THE TALLY. A FIXED NUMBER OF BEATS, whatever the ladder pays: it used
        // to take one per point the WINNER owed, which tied the length of the
        // board to the top of POINTS_BY_RANK — widening that from 9 to 15
        // stretched it by two thirds with nothing here changing. A row still
        // moves WHOLE POINTS; it just moves as many as the clock has reached.
        let most = view.listRows.map(\.owed).max() ?? 0
        guard most > 0 else { accounted = 1; onSettled(); return }
        let tickMs = max(16.0, view.racePhaseMs * Self.tickOfPhase)
        let runMs = Double(Self.tallyBeats) * tickMs
        let startedAt = CACurrentMediaTime()
        while true {
            guard await sleep(ms: tickMs / 4) else { return }
            let elapsed = (CACurrentMediaTime() - startedAt) * 1000
            // QUANTISED TO THE BEAT. Rows owe different amounts, so on a
            // continuous clock their totals cross a whole number at different
            // instants — and a row that gains one just before the row under it
            // does overtakes and is overtaken back inside a frame. Every total
            // moves on the same beat instead.
            let beat = min(Self.tallyBeats, Int(elapsed / tickMs))
            withAnimation(.easeInOut(duration: tickMs / 1000)) {
                accounted = Double(beat) / Double(Self.tallyBeats)
            }
            if elapsed >= runMs { break }
        }
        accounted = 1
        // The cup is now told. Anything waiting on it — the phones — can say so.
        onSettled()
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

    /// The rows as they stand RIGHT NOW: the race phase is the race's order and
    /// states NO cup number at all; the standings phase is the cup table with
    /// each row's total part-way to what it banked, re-sorted on the totals
    /// being shown.
    private var rows: [LiveRow] {
        guard standings else {
            return view.raceRows.map { LiveRow(row: $0, total: nil, seat: 0) }
        }
        return view.listRows.enumerated()
            .map { seat, r in
                let done = Int((accounted * Double(r.owed)).rounded())
                return LiveRow(row: r, total: (r.pointsBefore ?? 0) + done, seat: seat)
            }
            .sorted { a, b in
                if a.row.joining != b.row.joining { return b.row.joining }
                let ta = a.total ?? -1, tb = b.total ?? -1
                if ta != tb { return ta > tb }
                // A TIE MOVES NOBODY until the very end. Breaking one by `seat`
                // — the FINAL order — makes a level score display the finish
                // early: two rows whose totals leapfrog tie on one beat, the
                // lower jumps ahead because it is going to end up there, and the
                // next beat takes it back. Mid-tally a tie keeps the order the
                // rows came in on; only the settled board sorts on the model's,
                // which is what lands it exactly where the model said.
                if accounted >= 1 { return a.seat < b.seat }
                let pa = a.row.pointsBefore ?? 0, pb = b.row.pointsBefore ?? 0
                return pa == pb ? a.seat < b.seat : pa > pb
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
        // ONE WIDTH, FULL STOP. Every row builds the same three trailing cells
        // whichever beat it is for, and a beat with nothing to say in one leaves
        // it EMPTY rather than leaving it out — so a race result, a cup table
        // and a podium are all the same size, on this shell and on the web.
        let width = Self.boardWidthCup
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
        .opacity(listOpacity)
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
    /// The cut's dip, as a fraction of the model's phase-1 hold.
    private static let fadeOfPhase = 0.055
    /// How many beats the tally takes, whatever the ladder pays. See runPhases.
    private static let tallyBeats = 8

    /// `#results h2` (4.6rem) and `.is-champs h2` (3.4rem) on a 1080p board.
    private static let titleSizePlain: CGFloat = 74
    private static let titleSize: CGFloat = 54

    /// ONE ROW WIDTH FOR EVERY BOARD, sized by the name column and measured
    /// against the web.
    ///
    /// Every beat builds the same three trailing cells and leaves the ones it has
    /// nothing to say in EMPTY, so a race result, a cup table and a podium are all
    /// this wide — there is no longer a number per KIND. A row is rank (1.6em) +
    /// gap + NAME + gap + the three cells (3.6 + 2.7 + 4.2em with two gaps) + 12pt
    /// padding either side; at the old 410 that left the name about 52pt and every
    /// eight-row cup board truncated to "Th…", for as long as the board has had two
    /// columns. The web gives the same 24pt type a ~147pt name column on a 502pt
    /// row. Fixed rather than measured, because the beats must not re-measure
    /// between them.
    private static let boardWidthCup: CGFloat = 502

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
            // WHICH CELL A BEAT SPEAKS IN is the row's KIND, and the cells it
            // has nothing to say in are still THERE, empty, holding their width:
            //   time_gain  the race:  the lap clock. Cup cells reserved.
            //   points     the cup:   the score and the total. Clock reserved.
            //   time       a single race: the clock, cup cells reserved too — it
            //              has no second beat of its own to line up with, so it
            //              lines up with the OTHER boards.
            //
            // THE ROW'S LAST NUMBER SITS AT THE RIGHT EDGE in both beats, which
            // is why the order differs: the standings end on the total, so the
            // race ends on the lap clock and keeps its two reserved cells to the
            // LEFT of it. A row whose one figure floated in the middle read as a
            // column that had lost its heading.
            let cup = row.kind == "points"
            if cup {
                timeCell("")
                gainCell(shown: true)
                ptsCell(shown: true)
            } else {
                gainCell(shown: false)
                ptsCell(shown: false)
                timeCell(row.finished ? Copy.seconds(row.time ?? 0) : Copy.dnf)
            }
        }
    }

    private func timeCell(_ text: String) -> some View {
        // `.res-time { color: var(--ink-2) }` — quieter than the name. At full
        // ink the lap time competed with the one word that says whose row it is.
        cell(text, width: Self.type * 3.6,
             color: row.finished ? Tokens.ink2 : Tokens.ink3)
    }

    /// Zero is still printed ("+0") and styled quiet, so the column never goes
    /// ragged — but ONLY zero: the whole point of the column is that the eye
    /// picks out who scored.
    ///
    /// The width holds the WIDEST gain the ladder pays, not the settled "+0" the
    /// tally ends on: this cell is a hard width, so a gain that outgrows it clips
    /// rather than pushing the board wider. `.res-gain`'s min-width in
    /// display.css carries the same number.
    ///
    /// It retires at settle — it would otherwise rest on "+0", which reads as
    /// "scored nothing" on a board that stays up for the rest of the
    /// intermission. The lap clock needs no retiring: it went at the CUT.
    private func gainCell(shown: Bool) -> some View {
        cell(shown ? Copy.gained(row.gained ?? 0) : "",
             width: Self.type * 2.7,
             color: settled ? Color.clear : ((row.gained ?? 0) > 0 ? Tokens.brand : Tokens.ink3))
    }

    /// On screen from the standings phase's FIRST frame, holding the value the
    /// row came in with: a total that merely APPEARED in the beat that changes it
    /// would have no readable starting point for the climb.
    private func ptsCell(shown: Bool) -> some View {
        cell(shown ? (live.total.map(Copy.points) ?? "") : "",
             width: Self.type * 4.2, color: Tokens.ink2)
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
