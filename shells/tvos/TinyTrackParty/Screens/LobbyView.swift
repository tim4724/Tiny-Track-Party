import Foundation
import SwiftUI

/// The lobby: three clusters of sticker chrome pinned to the glass, over the
/// paper diorama before the host picks and over the live 3D track preview after.
///
/// **The layout is identical in both states** — that is the web's own rule
/// (`display.css`, `#lobby`) and the reason nothing here is conditional on the
/// backdrop: the ticket stays on the left rail, the cup slot on the right, the
/// seat dock across the foot, and only what is BEHIND them crossfades. Chrome
/// over the live 3D view floats bare (no paper, no panel), which falls out of
/// this composition for free.
///
/// **NOTHING ON THIS SCREEN IS DECIDED HERE.** Every value is a `GameState`
/// property some `ttp_*` call produced: the seat grid and its open-seat padding
/// are `ttp_ui_roster_seats_room_json` + `ttp_ui_seat_grid_json`, the race card
/// is `ttp_ui_cup_slot_json`, the START gate is `ttp_ui_all_racers_ready`, and
/// the join URL is `session.h`'s `join_url`. If a change to this file needs an
/// `if` about the game, it belongs in `libttp-runtime/ttp/ui_model.cc`.
///
/// WHAT THE WEB HAS THAT THIS DROPS: the ticket is a `<button>` that copies the
/// join link, confirmed by a toast. tvOS has no clipboard a viewer could paste
/// from and no second device holding the remote, so both go (ledger 3.1). What
/// replaces "copy the link" is what always mattered on a TV — the URL is printed
/// large enough to type.
@MainActor
struct LobbyView: View {

    @ObservedObject var state: GameState

    private static let railGap: CGFloat = 36
    private static let bandGap: CGFloat = 24

    /// Where the remote is. `parked` is a stop that draws nothing — see
    /// `focusPark`.
    @FocusState private var focus: Focus?

    private enum Focus: Hashable { case parked, info }

    var body: some View {
        ZStack {
            backdrop
            VStack(spacing: Self.bandGap) {
                topBand
                SeatDock(seats: state.seats)
            }
            // Inside the safe area, unlike the backdrop. tvOS's own margins are
            // ~90 points on a side, which is already the web's 4.5vw gutter, so
            // this adds only enough to keep the sticker tilts and their hard
            // shadows off the edge of the picture.
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            infoBand
            focusPark
        }
        // The remote arrives PARKED, not on the ⓘ. See `focusPark`.
        .defaultFocus($focus, .parked)
        .onAppear { focus = .parked }
        #if DEBUG
        .overlay(alignment: .bottomTrailing) { BuildTag() }
        #endif
    }

    // MARK: - (d) The info corner

    /// The ⓘ in the top-right corner, and the only control on this board.
    ///
    /// It opens the legal board (privacy, imprint, licenses), which is the one
    /// thing a TV app owes its viewer that no phone in the room can show them.
    /// Everything else here is still driven from the phones — see the note below
    /// about the START button that is deliberately absent.
    ///
    /// The full-width `.focusSection()` is what makes a far corner REACHABLE:
    /// a d-pad Up from the bottom of the board projects a narrow vertical beam
    /// that misses a small target off in a corner, and a section spanning the
    /// top edge catches the move and routes it to its only focusable child.
    /// That is the tvOS API for exactly this problem, not a workaround.
    private var infoBand: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Spacer()
                NavigationLink(value: GameState.InfoRoute.info) {
                    InfoGlyph()
                }
                .buttonStyle(InfoBadgeStyle())
                .focusEffectDisabled()
                .fixedSize()
                .focused($focus, equals: .info)
                // Icon-only, so it has no visible label to be found by: this is
                // what a screen reader announces and what the UI test presses.
                .accessibilityIdentifier("info-button")
                .accessibilityLabel(Copy.info)
            }
            .padding(.top, 4)
            .padding(.trailing, 16)
            .focusSection()
            Spacer()
        }
    }

    /// A focus stop that draws nothing, holding the remote at the foot of the
    /// board while the lobby is just standing there.
    ///
    /// **THE ⓘ MUST NOT BE FOCUSED WHEN THE LOBBY APPEARS**, and on tvOS that
    /// takes a second focusable view: the focus engine always seats focus
    /// somewhere, so a board with exactly one control opens with that control
    /// lit up — a permanent white ring in the corner of a screen the room is
    /// looking at to read a join code. Parking focus on nothing means the first
    /// press of the remote lights the ⓘ, which is the moment a viewer is
    /// actually asking for it.
    ///
    /// It sits along the bottom edge so the geometry is honest: Up from here is
    /// the ⓘ's band, and there is nothing else to reach. Select on it does
    /// nothing, deliberately — the board has no default action.
    private var focusPark: some View {
        VStack(spacing: 0) {
            Spacer()
            Color.clear
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .focusable()
                .focusEffectDisabled()
                .focused($focus, equals: .parked)
                .accessibilityHidden(true)
        }
    }

    // MARK: - Backdrop

    /// Paper before a track is picked, the live 3D preview after.
    ///
    /// The crossfade is one of the two pieces of global chrome the ledger says
    /// to KEEP (3.1). It is a fade of the PAPER, not of the scene: the Metal
    /// surface is a sibling at the bottom of the app's ZStack and keeps drawing
    /// underneath, so this view has nothing to switch off — it gets out of the
    /// way. `sceneVisible` is set by the coordinator, never derived here.
    private var backdrop: some View {
        PaperStage { Color.clear }
            .opacity(state.sceneVisible ? 0 : 1)
            .animation(.easeInOut(duration: 0.45), value: state.sceneVisible)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    // MARK: - Bands

    /// Ticket left, cup slot right, and the middle deliberately EMPTY — that gap
    /// is where the track preview is meant to be seen, and it is the reason the
    /// two rails are rails rather than a centred stack.
    private var topBand: some View {
        HStack(alignment: .center, spacing: Self.railGap) {
            // Each rail sizes its own card (see `LobbyViewMetrics`) rather than
            // being framed here: the scan hint is deliberately allowed to hang
            // wider than the ticket it belongs to, exactly as the web lets it
            // (`max-width: 120%`), and a frame at this level would wrap it
            // instead.
            JoinTicket(joinURL: state.joinURL, roomCode: state.roomCode, qr: state.joinQR)
            Spacer(minLength: 0)
            // HIDDEN ENTIRELY pre-pick — not an empty card, not a placeholder.
            // The model answers null until the host has picked, and an empty
            // sticker would promise a card that has nothing to say.
            if let slot = state.cupSlot {
                CupCard(slot: slot)
            }
        }
        .frame(maxHeight: .infinity)
    }

    // THERE IS STILL NO START BUTTON ON THIS BOARD, and its absence is the
    // design. The ⓘ above is not a counter-example: it opens a legal board that
    // no phone in the room can show and that the game does not react to, which
    // is the opposite of a second road into a rule the phones already own.
    //
    // A TV shell "needs an affordance of its own" was the argument for adding
    // one, and it is wrong twice over. The host already has the affordance: the
    // phone they picked the cup on has a START button (`MSG.START_GAME`), which
    // this display obeys — it is not a control the TV was missing, it is a
    // control the TV was DUPLICATING. And the duplicate is not equivalent, it is
    // weaker: it skips the "who". Whoever holds the remote starts the race,
    // which on a sofa with four phones is whoever is nearest the coffee table.
    //
    // What it cost was a second road into `startRace()` that the web has no twin
    // for, and therefore no shared test — the one that shipped broken for the
    // whole port, four separate ways, while fifteen screenshots looked perfect.
    //
    // A lobby with nothing to START is CORRECT here. There is nothing for the
    // remote to do about the GAME while the phones are driving, and tvOS's Menu
    // button still works (it is `RootView.backAction`'s, not a view's).
}

// MARK: - The ⓘ badge

/// The info button's glyph: an SF Symbol at the badge's size, and nothing else.
/// The sticker around it belongs to the style below, which is where the kit puts
/// a button's face.
@MainActor
private struct InfoGlyph: View {
    /// Small on purpose. It is the least important thing on the board and must
    /// not compete with the join code; at 56 points it is still a comfortable
    /// remote target and legible across a room.
    static let diameter: CGFloat = 56

    var body: some View {
        Image(systemName: "info")
            .font(.system(size: Self.diameter * 0.5, weight: .heavy))
            .frame(width: Self.diameter, height: Self.diameter)
    }
}

/// The badge, and its focus state.
///
/// **FOCUS FILLS IT.** The kit says focus by brightening, lifting and deepening
/// the shadow, and on a WHITE DISC all three are invisible: photographed on the
/// device, the focused ⓘ and the resting one were the same picture, so pressing
/// Up appeared to do nothing at all. A sticker's other way of saying "this one"
/// is colour, so focus swaps the face to blue with a white glyph — a chrome
/// colour (`theme.css` allows red/green/blue/purple and nothing else), and the
/// same blue the info board's own labels wear.
///
/// The press is the scale dropping back rather than `--btn-sink`: a circle has
/// no ledge to sink onto.
private struct InfoBadgeStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration)
    }

    private struct Face: View {
        let configuration: InfoBadgeStyle.Configuration
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            configuration.label
                .foregroundStyle(isFocused ? .white : Tokens.ink)
                .background(
                    Circle()
                        .fill(isFocused ? Tokens.blue : Tokens.surface)
                        .hardShadow(isFocused ? Sticker.focusShadow : Sticker.popShadow)
                )
                .overlay(Circle().strokeBorder(Tokens.ink, lineWidth: Sticker.border))
                .scaleEffect(configuration.isPressed ? 0.94
                             : isFocused ? Sticker.focusScale : 1)
                .animation(.easeOut(duration: 0.06), value: configuration.isPressed)
                .animation(.easeOut(duration: 0.12), value: isFocused)
        }
    }
}

// MARK: - (a) Join ticket

/// The wordmark masthead over the QR and the join URL, on one sticker card, with
/// the scan hint hanging under it.
///
/// The QR is the lobby's MAIN element and is sized like it. Everything else on
/// this card exists to make the code usable by someone who cannot scan: the URL
/// is printed in full, and its trailing ROOM CODE is broken onto its own line in
/// the accent colour, because that is the only part that changes per party and
/// the only part worth reading from a sofa.
@MainActor
private struct JoinTicket: View {
    /// The WHOLE link, exactly as the QR encodes it. What is printed is the
    /// readable half of it — see `displayURL`.
    let joinURL: String
    let roomCode: String
    let qr: CGImage?

    var body: some View {
        VStack(spacing: 14) {
            StickerCard(tint: Tokens.surface, rotation: -1.2, padding: LobbyViewMetrics.cardPadding) {
                VStack(spacing: 10) {
                    // `dieCut: false` — the badge's white edge is invisible on a
                    // white card, which is exactly why `.ticket__wordmark`
                    // zeroes the text stroke. Same face, same tilt, no edge.
                    Wordmark(size: 38, dieCut: false)
                    qrPanel
                    urlLines
                }
            }
            .frame(width: LobbyViewMetrics.ticketWidth)
            scanHint
        }
    }

    /// A square is reserved whether or not the code has arrived, so the card
    /// holds its final footprint from the first paint (the web reserves it with
    /// `aspect-ratio` on the canvas for the same reason: a blank `<canvas>` is
    /// 300x150 and the card would pop taller when the QR landed).
    @ViewBuilder
    private var qrPanel: some View {
        let side = LobbyViewMetrics.ticketInner
        if let qr {
            Image(decorative: qr, scale: 1)
                // FILTERED, and the reasoning that said otherwise had the
                // direction of the resample backwards.
                //
                // Nearest neighbour keeps a QR crisp when it is being ENLARGED —
                // one source pixel becomes a block of screen pixels and the
                // module edges stay hard. Neither thing that happens to this
                // bitmap is an enlargement. `QRCode` renders ~800 px and the
                // panel is 308 POINTS, so it is a 2.6x DOWNSCALE (1.3x on a 4K
                // box), and the card it sits on carries the sticker kit's
                // `rotationEffect(-1.2°)`. Point-sampling a rotated downscale
                // drops most of the source and lands the survivors on a slanted
                // grid: every module edge comes back as a staircase and the
                // finder patterns grow ragged corners. That is what "the QR is
                // not smooth" is.
                //
                // The web looks right doing what LOOKS like the same thing
                // (`#qr { image-rendering: pixelated }` inside a `.ticket`
                // rotated by the same -1.2°) and is not: the browser rasterises
                // the pixelated bitmap into a layer and then rotates the LAYER,
                // antialiasing that step. SwiftUI has one sampler for the whole
                // transform, so the choice here has to cover both halves.
                //
                // Filtering also SCANS better, which is the part worth keeping
                // straight: aliasing can thin a module to nothing or merge two,
                // and a decoder cannot recover either.
                .interpolation(.high)
                .antialiased(true)
                .resizable()
                .frame(width: side, height: side)
        } else {
            Color.clear.frame(width: side, height: side)
        }
    }

    /// What is actually printed: `host + pathname`, the readable half.
    ///
    /// `state.joinURL` holds the WHOLE link, because that is what the QR has to
    /// encode — `session.h`'s `join_url` is `base + "/" + room` plus an optional
    /// `#instance` fragment that pins the relay shard. The web trims it at the
    /// point of display for exactly the same reason this does (`main.js`:
    /// `const u = new URL(joinUrl); renderJoinUrl(el, u.host + u.pathname, …)`):
    /// a scheme and a shard pin are noise to someone typing a URL off a TV, and
    /// the fragment travels in the QR regardless.
    ///
    /// It also has to happen before the code split below — a URL ending in
    /// `#shard` does not end in the room code, so the accent line would silently
    /// never appear.
    private var displayURL: String {
        guard let u = URL(string: joinURL), let host = u.host(percentEncoded: false) else {
            return joinURL   // `new URL()` throwing is the web's fallback too
        }
        return host + u.path(percentEncoded: false)
    }

    /// `renderJoinUrl`'s rule (`display/Net.js`): split the code off the tail
    /// only when it IS the tail, otherwise print the string whole. Presentation,
    /// not policy — the URL itself was composed in C++.
    private var lines: (host: String, code: String?) {
        let full = displayURL
        guard !roomCode.isEmpty, full.hasSuffix(roomCode) else { return (full, nil) }
        return (String(full.dropLast(roomCode.count)), roomCode)
    }

    private var urlLines: some View {
        let split = lines
        return VStack(spacing: 2) {
            Text(split.host)
                .font(Fonts.display(22, weight: .semibold))
                .foregroundStyle(Tokens.ink)
                // The web wraps this `anywhere` rather than truncating, because
                // an ellipsis eats the tail and the tail is the room code. A
                // host has no spaces to break at and SwiftUI has no
                // break-anywhere, so this shrinks instead of clipping — the
                // failure mode a preview host (up to ~76 chars) actually needs.
                .minimumScaleFactor(0.55)
                .lineLimit(2)
            if let code = split.code {
                Text(code)
                    .font(Fonts.display(32, weight: .bold))
                    .tracking(32 * 0.04)
                    .foregroundStyle(Tokens.accent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
        }
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(joinURL)
    }

    /// A quiet white sticker hanging under the ticket for the whole lobby —
    /// joining stays possible until the race starts.
    ///
    /// The web positions this absolutely so its pre/post-pick toggle cannot move
    /// the card; there is no toggle here (it is always up), so it is simply the
    /// next thing in the stack.
    private var scanHint: some View {
        Text(Copy.scanPrompt)
            .font(Fonts.display(22, weight: .semibold))
            .foregroundStyle(Tokens.ink)
            .fixedSize()          // one line, overhanging the ticket rather than wrapping
            .multilineTextAlignment(.center)
            .padding(.vertical, 13)
            .padding(.horizontal, 24)
            .background(
                RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)
                    .fill(Tokens.surface)
                    .hardShadow(Sticker.popShadow)
            )
            .stickerOutline(Sticker.border, radius: Sticker.radius)
            .rotationEffect(.degrees(-2))
    }
}

// MARK: - (b) Cup slot

/// The race card: what the host picked, as a red cup sticker over the circuits
/// it will run, a races pill and a difficulty meter.
///
/// Every field is `ttp_ui_cup_slot_json`'s, including the NUMBERING of the maps
/// (`n` = 1...4) — a cup's running order is the GP menu at a glance, and the
/// model owns it. This view looks nothing up and counts nothing.
@MainActor
private struct CupCard: View {
    let slot: GameState.CupSlot

    private static let mapGap: CGFloat = 10

    var body: some View {
        StickerCard(tint: Tokens.surface, rotation: 1.2, padding: LobbyViewMetrics.cardPadding) {
            VStack(spacing: 12) {
                sticker
                maps
                racesPill
                // The WHOLE meter goes when there is no difficulty — a cup with
                // no tendency has nothing to say, and four empty pips would say
                // "the easiest there is".
                if let difficulty = slot.difficulty {
                    meter(difficulty)
                }
            }
        }
        .frame(width: LobbyViewMetrics.cupWidth)
    }

    /// `NAME_COPY[m.nameKey] || m.name || '?'`, straight from
    /// `renderLobbyPick`. The model answers a KEY plus data and never composed
    /// copy, so the strings are `Copy`'s — random and the tour have no `name`
    /// (there is nothing to resolve), a cup or an exact track always does.
    private var name: String {
        switch slot.nameKey {
        case "random": return Copy.random
        case "tour": return Copy.worldTour
        default: return slot.name ?? Copy.unknownValue
        }
    }

    private var sticker: some View {
        Text(name)
            .font(Fonts.display(27, weight: .bold))
            .foregroundStyle(.white)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.6)
            .padding(.vertical, 12)
            .padding(.horizontal, 20)
            .background(
                RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)
                    .fill(Tokens.red)
                    .hardShadow(Sticker.cardShadow)
            )
            .stickerOutline(Sticker.border, radius: Sticker.radius)
            .rotationEffect(.degrees(-2))
    }

    /// The web's `.cup-maps` box-count layouts, not mode hooks: ONE map at 72%
    /// width for an exact pick, 2-wide for a cup's four, 3-wide for the tour's
    /// five (the ladder itself), 4-wide for the long random card's strip of
    /// pips. The count comes from the model (or the veil); this only chooses
    /// how to arrange what it was handed.
    @ViewBuilder
    private var maps: some View {
        if slot.maps.count == 1, let only = slot.maps.first {
            tile(only).frame(width: LobbyViewMetrics.cupInner * 0.72)
        } else if !slot.maps.isEmpty {
            let cols = slot.maps.count >= 6 ? 4 : (slot.maps.count == 5 ? 3 : 2)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Self.mapGap),
                                     count: cols),
                      spacing: Self.mapGap) {
                ForEach(slot.maps) { tile($0) }
            }
        }
    }

    private func tile(_ map: GameState.CupSlot.Map) -> some View {
        // The badge hangs OFF the tile's top-left corner (the CSS puts it at
        // -6, -6), which is the sticker idiom: a number slapped on the corner
        // rather than inset into the picture.
        Group {
            if let trackId = map.trackId {
                // A chip's own `cup` outranks the card-level tint, exactly as
                // renderCupSlot resolves it.
                SchematicMap(trackId: trackId, cupId: map.cup ?? slot.cupId)
            } else {
                QuestionTile(glyph: map.glyph, cup: map.cup)
            }
        }
        .overlay(alignment: .topLeading) {
            // The web omits the badge when the model sends no `n` (an exact
            // track has nothing to number). `GameState.Map.n` cannot be nil,
            // so 0 stands in for absent.
            if map.n > 0 { badge(map.n).offset(x: -9, y: -9) }
        }
    }

    private func badge(_ n: Int) -> some View {
        Text("\(n)")
            .font(Fonts.display(16, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.vertical, 2)
            .padding(.horizontal, 8)
            .background(Capsule().fill(Tokens.ink))
    }

    /// `.cup-races` — an OUTLINE pill (ink on paper), which is not the kit's
    /// `.pill` (white on solid ink, `StickerPill`). Two different marks: the kit
    /// pill is a label, this is a quiet fact about the card it sits on.
    private var racesPill: some View {
        Text(Copy.races(slot.racesKey, count: slot.raceCount).uppercased())
            .font(Fonts.display(19, weight: .semibold))
            .tracking(19 * 0.1)
            .foregroundStyle(Tokens.ink)
            .padding(.vertical, 6)
            .padding(.horizontal, 18)
            .background(
                Capsule()
                    .fill(Tokens.surface)
                    .hardShadow(Sticker.popShadow)
            )
            .overlay(Capsule().strokeBorder(Tokens.ink, lineWidth: Sticker.hairlineBorder))
    }

    /// Four pips, the first `difficulty` of them filled RED — the celebration
    /// colour, never the old green-to-amber ramp (amber is vetoed in chrome).
    /// A TENDENCY for the whole cup, not a rating for a track.
    private func meter(_ difficulty: Int) -> some View {
        HStack(spacing: 8) {
            ForEach(0..<4, id: \.self) { i in
                Circle()
                    .fill(i < difficulty ? Tokens.red : Tokens.surface)
                    .frame(width: 16, height: 16)
                    .overlay(Circle().strokeBorder(Tokens.ink, lineWidth: 2.5))
            }
        }
        .accessibilityElement(children: .ignore)
        // COPY DEBT, like START's label: transcribed from `cupMeter`'s own
        // aria-label (`shared/trackPicker.js`) rather than invented, and it
        // belongs in `Copy.swift` with the rest.
        .accessibilityLabel("difficulty \(difficulty) of 4")
    }
}

/// An undrawn race: a mini-map's exact footprint under a big glyph
/// (`.cup-maps__tile--q`). The wash is its own cup's colour when the chip
/// names one (the tour's ladder), the picker's neutral grey when even the cup
/// is unknown (a random run's races) — never the card-level tint, because an
/// unknown must not borrow the drawn race's colour.
@MainActor
private struct QuestionTile: View {
    let glyph: String
    let cup: String?

    var body: some View {
        GeometryReader { geo in
            ZStack {
                cup != nil ? Schematic.fieldTint(cupId: cup) : Schematic.neutralTint
                // The glyph tracks its own BOX, not the card — 34% of the tile
                // whether that tile is the endless card's lone big square or
                // one of the long card's eight small ones (the CSS's 34cqw).
                Text(glyph)
                    .font(Fonts.display(geo.size.width * 0.34, weight: .bold))
                    .foregroundStyle(Tokens.ink)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Sticker.radiusSmall, style: .continuous))
        .stickerOutline(Sticker.hairlineBorder, radius: Sticker.radiusSmall)
        .accessibilityHidden(true)   // the races pill counts the run in words
    }
}

// MARK: - (c) Seat dock

/// The roster across the foot of the board.
///
/// **ALREADY PADDED.** `ttp_ui_seat_grid_json` fills the row out to
/// `maxPlayers` with open placeholders, and the padding is the MODEL's job
/// precisely so that three shells cannot pad differently. Nothing here counts
/// seats, and an empty array means the shell has not asked yet — it draws
/// nothing rather than inventing four.
@MainActor
private struct SeatDock: View {
    let seats: [GameState.Seat]

    var body: some View {
        HStack(spacing: 18) {
            ForEach(seats) { SeatCard(seat: $0) }
        }
        // THE DOCK KEEPS ITS OWN HEIGHT. The band above it is `maxHeight:
        // .infinity` — deliberately, so the middle of the board stays empty for
        // the track preview — and a greedy sibling means a VStack under pressure
        // takes the space back out of THIS one. It came out of the only flexible
        // thing in a seat card, the name box, so every label on the dock was
        // clipped at the baseline: "Open" on an empty lobby, and every player's
        // name on a full one.
        //
        // Asking for the ideal height rather than trimming the band, because the
        // cards are the fixed thing here: their size is authored (150 points, a
        // 5:4 thumbnail, two lines of name) and the empty middle is what should
        // give.
        .fixedSize(horizontal: false, vertical: true)
    }
}

@MainActor
private struct SeatCard: View {
    let seat: GameState.Seat

    /// The web's card is `clamp(100px, 9.5vw, 134px)`, authored for a monitor at
    /// arm's length. This is the same call `Sticker.swift` made for `.chip` and
    /// `.pill`: opened up for the sofa, where a 134-point card with a 21-point
    /// name on it is a smudge.
    private static let width: CGFloat = 150

    var body: some View {
        VStack(spacing: 2) {
            picture
            name
        }
        .padding(.horizontal, 8)
        .padding(.top, 7)
        .padding(.bottom, 9)
        .frame(width: Self.width)
        .background(background)
        .overlay(alignment: .topTrailing) { marker }
        // A DROPPED SEAT IS DIMMED, NEVER REMOVED: it is still theirs to come
        // back to, and the room is holding it. Same 0.5 as `.seat--off`.
        .opacity(seat.off ? 0.5 : 1)
        // Neighbours lean opposite ways, like stickers slapped down one after
        // another (`nth-child(odd/even)`; the grid's first cell is index 0).
        .rotationEffect(.degrees(seat.index % 2 == 0 ? -1.4 : 1.4))
    }

    @ViewBuilder
    private var picture: some View {
        if seat.open {
            // The placeholder holds exactly the thumbnail's box, so an open seat
            // is the same size as a taken one and the dock cannot lift when
            // someone joins.
            Color.clear.aspectRatio(5.0 / 4.0, contentMode: .fit)
        } else {
            CarThumbnail(modelIndex: seat.modelIndex, livery: Tokens.car(seat.colorIndex))
        }
    }

    /// The name carries the player's LIVERY (`--c` on the web), which is why
    /// there is no colour dot on this card: the type is the swatch.
    private var name: some View {
        Text(seat.open ? Copy.openSeat : seat.name)
            .font(Fonts.display(26, weight: .bold))
            .foregroundStyle(seat.open ? Tokens.ink3 : Tokens.car(seat.colorIndex))
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.6)
            // ALWAYS two lines of box, whatever it holds. The card's height is
            // then the same from "Open" through to a name that wraps, so the
            // dock cannot jump when someone called "Alexandra Smith" joins.
            //
            // THE BOX IS THE FONT'S, not a guess at it. This was `26 * 1.15 * 2`
            // — a made-up 1.15 leading — and Fredoka at 26 is taller than that,
            // so the glyphs overflowed a box too short for them and every label
            // on the dock was cut off at the baseline. "Open" and every player
            // name, on every screenshot this shell has taken.
            //
            // `lineHeight` asks the font. `fixedSize(vertical:)` then stops a
            // squeezed parent from taking the space back: the dock sits under a
            // greedy top band, and a VStack under pressure compresses its
            // children rather than overflowing.
            .fixedSize(horizontal: false, vertical: true)
            .frame(height: Fonts.lineHeight(26, weight: .bold) * 2)
    }

    @ViewBuilder
    private var background: some View {
        let shape = RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)
        if seat.open {
            // A dashed die-cut outline over half-transparent white: visibly a
            // slot rather than a card, and no drop shadow, so it sits flat while
            // the taken seats sit proud.
            shape.fill(Color.white.opacity(0.5))
                .overlay(
                    shape.strokeBorder(Tokens.ink.opacity(0.45),
                                       style: StrokeStyle(lineWidth: Sticker.border, dash: [12, 9]))
                )
        } else {
            shape.fill(Tokens.surface).hardShadow(Sticker.popShadow)
                .overlay(shape.strokeBorder(Tokens.ink, lineWidth: Sticker.border))
        }
    }

    /// The two corner markers are MUTUALLY EXCLUSIVE by the model's rule — the
    /// host never readies — so they share one slot and this view arbitrates
    /// nothing. The web relies on the same fact (its CSS pins both to the same
    /// corner and simply lets them not collide).
    @ViewBuilder
    private var marker: some View {
        if seat.host {
            hostStar.offset(x: 12, y: -14)
        } else if seat.ready {
            readyCheck.offset(x: 10, y: -10)
        }
    }

    /// SF Symbols stands in for the web's inline SVG paths. The glyph is the
    /// platform's; the STICKER is the ink ring around it, which is the part the
    /// look actually lives in.
    private var readyCheck: some View {
        Image(systemName: "checkmark")
            .font(.system(size: 20, weight: .heavy))
            .foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Tokens.green))
            .overlay(Circle().strokeBorder(Tokens.ink, lineWidth: Sticker.hairlineBorder))
            .accessibilityLabel(Copy.ready)
    }

    /// The one gold in the whole shell.
    ///
    /// `#ffc83d` is hardcoded beside the star in `display.css` — it is not a
    /// `:root` token, so `design-tokens.json` does not carry it and `Tokens`
    /// cannot answer for it (the same reason `PaperStage`'s hills are literals).
    /// It also looks like a breach of the chrome veto on amber, and is not one
    /// by this shell's choice: it is the shipped display's own value,
    /// transcribed rather than re-decided. If the veto should reach it, it moves
    /// in both places at once.
    ///
    /// The ink edge is a larger star behind a smaller one — SwiftUI has no text
    /// or symbol stroke, and this is the same trick `Wordmark` uses for its
    /// die-cut edge (there, offset copies; here, one behind).
    private var hostStar: some View {
        ZStack {
            Image(systemName: "star.fill")
                .font(.system(size: 40))
                .foregroundStyle(Tokens.ink)
            Image(systemName: "star.fill")
                .font(.system(size: 32))
                .foregroundStyle(Color(red: 1, green: 200.0 / 255, blue: 61.0 / 255))
        }
        // Two stacked glyphs are two elements to VoiceOver, and one of them is a
        // black star that means nothing on its own.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Copy.host)
    }
}

// MARK: - Metrics shared by two cards

/// The two rails, and the inner width each leaves its content.
///
/// Constants rather than a `GeometryReader`, because the widths ARE constants
/// here: tvOS is always 1920x1080 POINTS whatever the box outputs (ledger 2.6),
/// so the web's `clamp()`s each resolve to one number (the left rail's 27vw
/// clamps to 430, the right rail's 17vw to 270, the column gap's 2vw to 36). A
/// reader would also make the QR's size depend on a layout pass that has not
/// happened on the first frame, which is the pop the web's `aspect-ratio`
/// reservation exists to avoid.
///
/// The rails are NARROWER than the web's clamps, and the reason is vertical, not
/// horizontal: this board has to fit the ticket band and the seat dock inside
/// tvOS's ~960 points of safe height, and the QR is square, so every point of
/// ticket width is also a point of ticket height.
private enum LobbyViewMetrics {
    static let cardPadding: CGFloat = 16
    static let ticketWidth: CGFloat = 340
    static let cupWidth: CGFloat = 300
    /// What is left inside each card. The QR takes the whole of the ticket's.
    static let ticketInner: CGFloat = ticketWidth - 2 * cardPadding
    static let cupInner: CGFloat = cupWidth - 2 * cardPadding
}

#if DEBUG
/// Dev-only build tag: the commit this binary was built from, read from
/// `assets/version.txt` (written by scripts/build.sh on every build). It exists
/// because a stale install is indistinguishable from a fresh one by looking —
/// the TV itself should answer "which commit is this?". Release compiles it out.
private struct BuildTag: View {
    private static let text: String? = {
        guard let url = Bundle.main.url(forResource: "version", withExtension: "txt",
                                        subdirectory: "assets"),
              let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return tag.isEmpty ? nil : tag
    }()

    var body: some View {
        if let tag = Self.text {
            Text(tag)
                .font(.system(size: 20, weight: .medium, design: .monospaced))
                .foregroundStyle(Tokens.color("ink").opacity(0.45))
                .padding(.trailing, 8)
        }
    }
}
#endif
