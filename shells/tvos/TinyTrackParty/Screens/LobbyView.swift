import Foundation
import SwiftUI

/// The lobby: three clusters of paper chrome pinned to the glass, over the
/// paper diorama before the host picks and over the live 3D track preview after.
///
/// **The layout is identical in both states** — that is the web's own rule
/// (`display.css`, `#lobby`) and the reason nothing here is conditional on the
/// backdrop: the ticket stays on the left rail, the cup slot on the right, the
/// seat dock at the foot of the middle, and only what is BEHIND them crossfades. Chrome
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

    /// Where the remote is. `parked` is a stop that draws nothing — see
    /// `focusPark`.
    @FocusState private var focus: Focus?

    private enum Focus: Hashable { case parked, info }

    var body: some View {
        ZStack {
            backdrop
            // ON THE OVERSCAN TOKEN, not tvOS's own ~90-point safe area: the web
            // and Android lay this board out on `--safe-frac-x/y`, and inside the
            // system inset every card here sat further in and read smaller than
            // its two siblings.
            band
                .padding(.horizontal, LobbyViewMetrics.safeX)
                .padding(.vertical, LobbyViewMetrics.safeY)
                .ignoresSafeArea()

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
            .padding(.top, LobbyViewMetrics.safeY)
            .padding(.trailing, LobbyViewMetrics.safeX)
            .focusSection()
            Spacer()
        }
        .ignoresSafeArea()
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
    /// How long the paper takes to get out of the way — except at boot, where
    /// `GameCoordinator`'s first-paint handler takes it away unanimated under the
    /// splash and lifts the splash on the same paint.
    static let backdropFade: Double = 0.45

    private var backdrop: some View {
        PaperStage { Color.clear }
            .opacity(state.sceneVisible ? 0 : 1)
            .animation(.easeInOut(duration: Self.backdropFade), value: state.sceneVisible)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    // MARK: - The band

    /// Ticket left, cup slot right, and the middle left to the track preview
    /// but for the seat dock along its floor — that gap is the reason the two
    /// rails are rails rather than a centred stack.
    private var band: some View {
        HStack(alignment: .center, spacing: Self.railGap) {
            // Each rail sizes its own card (see `LobbyViewMetrics`) rather than
            // being framed here: the scan hint is deliberately allowed to hang
            // wider than the ticket it belongs to, as Android's does, and a
            // frame at this level would wrap it instead. (The web wraps it at
            // the ticket's width, because its window can be squatter than a TV.)
            JoinTicket(joinURL: state.joinURL, roomCode: state.roomCode, qr: state.joinQR)
            // THE DOCK IS BESIDE THE RAILS, NOT BELOW THEM — the web's
            // `grid-template-areas: "ticket dock race"`. It used to be the second
            // row of a VStack, which made the board's height the tallest rail
            // plus the dock and, on the web where the viewport is not fixed at
            // 1080p, pushed the cars off the bottom edge. Here it never overflowed
            // (a TV board is one known size) but the composition is the same one
            // on three platforms, so it follows the same way: the middle is the
            // space the rails leave, and the dock hangs from the bottom of it.
            SeatDock(seats: state.seats)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            raceRail
        }
        .frame(maxHeight: .infinity)
    }

    /// Tonight's race over the long game: the pick floats in the middle of the
    /// rail, the cups shelf hangs from the BOTTOM.
    ///
    /// A `Spacer` EITHER SIDE of the pick is `.cup-slot { margin: auto 0 }`.
    /// Top-aligned it clung under the ⓘ with the whole surplus dropped in one
    /// hole between it and the shelf; two spacers split that surplus and it
    /// reads as air instead.
    ///
    /// The one below is also what pins the SHELF to the floor, and that is the
    /// half that must not become a distributed arrangement: the pick is ABSENT
    /// until the host chooses, and a rail that spread its children would park
    /// the lone shelf in the middle and then drop it when the pick arrived.
    /// Two spacers over nothing still leave the shelf on the floor, so it never
    /// moves.
    ///
    /// The rail is framed once, here, so both cards share the width the metrics
    /// authored for the right rail.
    private var raceRail: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            // HIDDEN ENTIRELY pre-pick — not an empty card, not a placeholder.
            // The model answers null until the host has picked, and an empty
            // card would promise something it has nothing to say about.
            if let slot = state.cupSlot {
                CupCard(slot: slot)
            }
            Spacer(minLength: 0)
            // Also hidden when empty, but for a different reason: an empty
            // catalogue means boot has not read one yet, and a card with no
            // rows in it is a blank slab of paper.
            if !state.cups.isEmpty {
                CupShelf(cups: state.cups, earned: state.starsEarned, total: state.starsTotal)
            }
        }
        .frame(width: LobbyViewMetrics.cupWidth)
        // CLEAR THE ⓘ. The badge floats in `infoBand`, a sibling of this whole
        // stack, so nothing about layout keeps it off a card that now hangs from
        // the top of the rail — photographed on the device, it sat on the pick
        // card's corner. The web pads its race rail for exactly this
        // (`.race-rail { padding-top: corner-btn + 0.5rem }`,
        // clearing the fixed mute/fullscreen row), and this is that padding.
        .padding(.top, InfoGlyph.diameter + 10)
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

/// The info button's glyph: a round dot over a rounded bar, DRAWN rather than an
/// SF Symbol, whose serifed "i" read as a letter in a different typeface from
/// everything around it. Android draws the same two shapes at the same
/// proportions (LobbyScreen.kt InfoBadge), so the key is one key on both TVs.
/// The key around it belongs to the style below, which is where the kit puts a
/// button's face.
@MainActor
private struct InfoGlyph: View {
    /// Small on purpose. It is the least important thing on the board and must
    /// not compete with the join code; at 54 points (Android's) it is still a
    /// comfortable remote target and legible across a room.
    static let diameter: CGFloat = 54

    var body: some View {
        let d = Self.diameter
        // Fractions of the key: the dot's centre at 0.29, the bar 0.44-0.74.
        return ZStack {
            Circle().frame(width: d * 0.17, height: d * 0.17).offset(y: d * (0.29 - 0.5))
            Capsule().frame(width: d * 0.155, height: d * 0.30).offset(y: d * (0.59 - 0.5))
        }
        .frame(width: d, height: d)
    }
}

/// The badge, and its focus state: `.icon-btn`, a CHOICE — a round white key
/// with the faint edge and an ink glyph, the same key the web's corner row is.
///
/// **FOCUS WASHES AND RINGS IT**, as a picked choice is: the blue pick wash, the
/// edge turned into a blue ring, and the TV's lift. A lift alone on a white disc
/// was invisible from the sofa — photographed on the device, the focused ⓘ and
/// the resting one were the same picture, so pressing Up appeared to do nothing.
///
/// The press is `.icon-btn:active`'s: a small squash and the press wash.
private struct InfoBadgeStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration)
    }

    private struct Face: View {
        let configuration: InfoBadgeStyle.Configuration
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            let pressed = configuration.isPressed
            return configuration.label
                .foregroundStyle(Tokens.ink)
                .background(Circle().fill(pressed ? Tokens.press : isFocused ? Tokens.pick : Tokens.surface))
                .overlay(Sticker.choiceEdge(Circle(), picked: isFocused))
                .scaleEffect(pressed ? 0.94 : isFocused ? Sticker.focusScale : 1)
                .animation(pressed ? nil : .easeOut(duration: 0.05), value: pressed)
                .animation(.easeOut(duration: 0.12), value: isFocused)
        }
    }
}

// MARK: - (a) Join ticket

/// The wordmark masthead over the QR and the join URL, on one paper card, with
/// the scan hint hanging under it.
///
/// The QR is the lobby's MAIN element and is sized like it. Everything else on
/// this card exists to make the code usable by someone who cannot scan: the URL
/// is printed in full, and its trailing ROOM CODE is broken onto its own line in
/// blue (`.ticket__cd`), because that is the only part that changes per party
/// and the only part worth reading from a sofa.
@MainActor
private struct JoinTicket: View {
    /// The WHOLE link, exactly as the QR encodes it. What is printed is the
    /// readable half of it — see `displayURL`.
    let joinURL: String
    let roomCode: String
    let qr: CGImage?

    var body: some View {
        VStack(spacing: 14) {
            StickerCard(padding: LobbyViewMetrics.ticketPadding) {
                VStack(spacing: 8) {
                    Wordmark(size: 38)
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
                // module edges stay hard. This bitmap is not enlarged: `QRCode`
                // renders ~800 px and the panel is 382 POINTS, a DOWNSCALE at
                // 1080p and close to 1:1 on a 4K box, and never an integer
                // multiple. Point-sampling a downscale drops most of the source:
                // every module edge comes back ragged, which is what "the QR is
                // not smooth" was (it was worse while the card still leaned).
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
        return ZStack {
            // `.ticket__wait`: "Loading…" holds the line until the room opens,
            // in the same box, so the swap is a crossfade and not a reflow.
            Text(Copy.loading)
                .font(Fonts.display(LobbyViewMetrics.urlSize, weight: .semibold))
                .foregroundStyle(Tokens.ink2)
                .opacity(joinURL.isEmpty ? 1 : 0)
            VStack(spacing: 2) {
                Text(split.host)
                    .font(Fonts.display(LobbyViewMetrics.urlSize, weight: .semibold))
                    .foregroundStyle(Tokens.ink)
                    // The web wraps this `anywhere` rather than truncating,
                    // because an ellipsis eats the tail and the tail is the room
                    // code. A host has no spaces to break at and SwiftUI has no
                    // break-anywhere, so this shrinks instead of clipping — the
                    // failure mode a preview host (up to ~76 chars) needs.
                    .minimumScaleFactor(0.55)
                    .lineLimit(2)
                if let code = split.code {
                    Text(code)
                        .font(Fonts.display(LobbyViewMetrics.urlSize * 1.45, weight: .bold))
                        .tracking(LobbyViewMetrics.urlSize * 1.45 * 0.08)
                        .foregroundStyle(Tokens.blue)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
            }
            .opacity(joinURL.isEmpty ? 0 : 1)
        }
        .multilineTextAlignment(.center)
        .animation(.easeOut(duration: 0.4), value: joinURL.isEmpty)
        // `.ticket__urlbox { min-height: 3.4em }`: the box holds its final
        // footprint before the code arrives.
        .frame(minHeight: LobbyViewMetrics.urlSize * 3.4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(joinURL.isEmpty ? Copy.loading : joinURL)
    }

    /// `.tagline`: a GLASS readout hanging under the ticket for the whole lobby —
    /// joining stays possible until the race starts. Held back until there is a
    /// code to scan, its box reserved from the start so the ticket never moves.
    ///
    /// The glass tint without the web's backdrop blur: what is behind it is the
    /// live attract race, and a blur re-run over that every frame buys nothing
    /// the 55% tint does not already give the white type.
    private var scanHint: some View {
        Text(Copy.scanPrompt)
            .font(Fonts.display(22, weight: .semibold))
            .foregroundStyle(.white)
            .fixedSize()          // one line, overhanging the ticket rather than wrapping
            .multilineTextAlignment(.center)
            .padding(.vertical, 13)
            .padding(.horizontal, 24)
            .background(RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)
                .fill(Tokens.glass))
            .opacity(qr == nil ? 0 : 1)
            .animation(.easeOut(duration: 0.4), value: qr == nil)
    }
}

// MARK: - (b) Cup slot

/// The race card: what the host picked, as a label in the cup's own colour over
/// the circuits it will run and a races pill.
///
/// Every field is `ttp_ui_cup_slot_json`'s, including the NUMBERING of the maps
/// (`n` = 1...N on every fixed run) — the running order is the menu at a
/// glance, and the model owns it. This view looks nothing up and counts nothing.
@MainActor
private struct CupCard: View {
    let slot: GameState.CupSlot

    private static let mapGap: CGFloat = 7
    private static let pillSize: CGFloat = 15

    var body: some View {
        StickerCard(padding: LobbyViewMetrics.cardPadding) {
            VStack(spacing: 11) {
                sticker
                maps
                racesPill
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

    /// `.cup-sticker`: a LABEL in the cup's own colour (the neutral grey for a
    /// run that belongs to no cup), because nothing here is pressed. The tint is
    /// the colour and the words stay INK: the label recipe's darkened text turns
    /// muddy on a pale cup colour (Beach's sand).
    private var sticker: some View {
        Text(name)
            .font(Fonts.display(27, weight: .bold))
            .foregroundStyle(Tokens.ink)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.6)
            .padding(.top, 27 * 0.35)
            .padding(.bottom, 27 * 0.4)
            .padding(.horizontal, 27 * 0.85)
            .background(Capsule().fill(Schematic.labelTint(cupId: slot.cupId)))
    }

    /// The web's `.cup-maps` box-count layouts, not mode hooks: ONE map at 72%
    /// width for an exact pick, 2-wide for a cup's four, 3-wide for the tour's
    /// five (the ladder itself), 4-wide for the long random card's strip of
    /// pips. The count comes from the model; this only chooses
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
        // The badge hangs OFF the tile's top-left corner (`top/left: -0.4em`):
        // a number on the corner rather than inset into the picture.
        Group {
            if map.locked {
                LockedTile()
            } else if let trackId = map.trackId {
                // A chip's own `cup` outranks the card-level tint, exactly as
                // renderCupSlot resolves it.
                SchematicMap(trackId: trackId, cupId: map.cup ?? slot.cupId)
            } else {
                QuestionTile(glyph: map.glyph, cup: map.cup)
            }
        }
        .overlay(alignment: .topLeading) {
            // The web omits the badge when the model sends no `n` (an exact
            // track and an endless run have nothing to number).
            // `GameState.Map.n` cannot be nil, so 0 stands in for absent.
            if map.n > 0 { badge(map.n).offset(x: -8, y: -8) }
        }
    }

    /// `.cup-maps__n`: a 20 pt digit in a 30 pt ink disc, the same geometry on
    /// every platform.
    private func badge(_ n: Int) -> some View {
        Text("\(n)")
            .font(Fonts.display(20, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(Circle().fill(Tokens.ink))
    }

    /// `.cup-races` — a quiet grey pill (ink-2 on the sunken paper), which is
    /// not the kit's tinted `.pill`: a fact about the card it sits on rather
    /// than a label in a colour.
    private var racesPill: some View {
        Text(Copy.races(slot.racesKey, count: slot.raceCount).uppercased())
            .font(Fonts.display(Self.pillSize, weight: .semibold))
            .tracking(Self.pillSize * 0.1)
            .foregroundStyle(Tokens.ink2)
            .padding(.vertical, Self.pillSize * 0.3)
            .padding(.horizontal, Self.pillSize * 0.95)
            .background(Capsule().fill(Tokens.surface2))
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
        .clipShape(RoundedRectangle(cornerRadius: Schematic.tileRadius, style: .continuous))
        .accessibilityHidden(true)   // the races pill counts the run in words
    }
}

/// The tour's teaser for a locked cup (`.cup-maps__tile--locked`): the "?"
/// tile's anatomy on sunken paper with a padlock where the glyph would be — a
/// rung on the ladder, not a race.
@MainActor
private struct LockedTile: View {
    var body: some View {
        GeometryReader { geo in
            ZStack {
                Tokens.surface2
                Image(systemName: "lock.fill")
                    .font(.system(size: geo.size.width * 0.34, weight: .bold))
                    .foregroundStyle(Tokens.ink)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Schematic.tileRadius, style: .continuous))
        .accessibilityHidden(true)   // the races pill counts the run in words
    }
}

// MARK: - (b2) Cups shelf

/// The couch's long game, under tonight's pick: one row per cup, wearing the
/// stars it has earned and the padlock it has not opened.
///
/// **ONE CARD, NOT FIVE PILLS** — the web's own finding (`display.css`,
/// `.cup-shelf`): five separate pills read as five things scattered down the
/// corner, and this is one thing. Rows are separated by a hairline rather than
/// by air for the same reason.
///
/// Every number is `ttp_ui_catalogue_json`'s. The star thresholds and the unlock
/// rule live in `libttp-runtime/ttp/progression.{h,cc}` and are DERIVED before
/// this ever sees them, which is why there is no arithmetic in this file — a
/// shell that counted its own stars would be a second answer to a question the
/// phones' picker already asks the same engine.
@MainActor
private struct CupShelf: View {
    let cups: [GameState.CupProgress]
    let earned: Int
    let total: Int

    var body: some View {
        StickerCard(padding: 0) {
            VStack(spacing: 0) {
                ForEach(Array(cups.enumerated()), id: \.element.id) { i, cup in
                    row(cup)
                    // Between rows only: a trailing rule under the last one
                    // would read as an empty sixth row (`:last-child { 0 }`).
                    if i < cups.count - 1 {
                        Rectangle().fill(Tokens.hairline).frame(height: 2)
                    }
                }
            }
            .padding(.top, 9)
            .padding(.bottom, 7)
            .padding(.horizontal, 14)
        }
        // The label rides the card's top-left corner like a tab. A full label
        // ROW is height this rail cannot spare — the web found that at 720p,
        // where it pushed the fifth cup off the shelf.
        .overlay(alignment: .topLeading) {
            StickerPill(Copy.cupsShelf(earned: earned, of: total), size: 14)
                .accessibilityLabel(Copy.cupsShelfSpoken(earned: earned, of: total))
                .offset(x: 11, y: -12)
        }
    }

    private func row(_ cup: GameState.CupProgress) -> some View {
        HStack(spacing: 9) {
            // A locked cup trades its colour dot for the padlock: it has no
            // identity to advertise yet.
            if cup.locked {
                Image(systemName: "lock.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Tokens.ink)
            } else {
                Circle()
                    .fill(Self.swatch(cup.color))
                    .frame(width: 13, height: 13)
            }
            Text(Self.shortName(cup.name))
                .font(Fonts.display(21, weight: .bold))
                // Locked RECEDES IN PLACE. It cannot take a sunken fill: inside
                // one card that reads as a hole punched in the paper.
                .foregroundStyle(cup.locked ? Tokens.ink2 : Tokens.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Spacer(minLength: 6)
            if cup.locked {
                // The unlock bar, as a star count ("★ 4/6"). On the television
                // it is a progress fact next to four cups that show stars, which
                // is the rule said shorter.
                HStack(spacing: 5) {
                    StarRow(earned: 1, total: 1)
                    Text("\(cup.unlockDone)/\(cup.unlockNeed)")
                        .font(Fonts.display(18, weight: .bold))
                        .foregroundStyle(Tokens.ink2)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Copy.cupsLocked(done: cup.unlockDone, need: cup.unlockNeed))
            } else {
                StarRow(earned: cup.stars)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 2)
    }

    /// Every row on this shelf is a cup, so " Cup" says nothing and the rail is
    /// too narrow to spend the width on it. Presentation, not data — `GameState`
    /// keeps the catalogue's real name.
    private static func shortName(_ name: String) -> String {
        name.hasSuffix(" Cup") ? String(name.dropLast(4)) : name
    }

    /// The catalogue's packed 0xRRGGBB, unmixed. `Schematic.wash` is the wrong
    /// helper here: it mixes 26% of the cup into white for a schematic FIELD,
    /// and a swatch that pale would not read as a colour at all.
    private static func swatch(_ rgb: UInt32) -> Color {
        Color(red: Double((rgb >> 16) & 0xFF) / 255,
              green: Double((rgb >> 8) & 0xFF) / 255,
              blue: Double(rgb & 0xFF) / 255)
    }
}

/// Three stars, `earned` of them filled.
///
/// RED, never gold: amber is vetoed in chrome and celebration is red
/// (`theme.css`, `.starrow .star`). No outline on an earned one; an unearned one
/// is HOLLOW, its outline in see-through ink (`.star--off`'s
/// `rgba(38, 40, 56, 0.42)`, a literal in the CSS), because a faint fill sinks
/// into the paper and a line does not.
@MainActor
private struct StarRow: View {
    let earned: Int
    var total = 3

    private static let off = Color(red: 38 / 255.0, green: 40 / 255.0, blue: 56 / 255.0).opacity(0.42)

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<total, id: \.self) { i in
                Image(systemName: i < earned ? "star.fill" : "star")
                    .font(.system(size: 15, weight: i < earned ? .bold : .regular))
                    .foregroundStyle(i < earned ? Tokens.red : Self.off)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Copy.stars(earned: earned, of: total))
    }
}

// MARK: - (c) Seat dock

/// The roster along the foot of the board's middle, between the two rails.
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
        // THE DOCK KEEPS ITS OWN HEIGHT. It sits in a `maxHeight: .infinity`
        // frame — deliberately, so the middle of the board stays empty for the
        // track preview above it — and a greedy child of that frame would take
        // the space back out of THIS one. It came out of the only flexible
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

    /// The web's `clamp(100px, 9.5vw, 134px)` at 1920, and Android's: one dock
    /// size on all three platforms.
    private static let width: CGFloat = 134
    private static let nameSize: CGFloat = 21

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

    /// The name carries the player's LIVERY (`--c` on the web, mixed 80% with
    /// ink so the palest liveries still read on white), which is why there is no
    /// colour dot on this card: the type is the swatch.
    private var name: some View {
        Text(seat.open ? Copy.openSeat : seat.name)
            .font(Fonts.display(Self.nameSize, weight: .bold))
            .foregroundStyle(seat.open ? Color.white.opacity(0.85)
                                       : Tokens.car(seat.colorIndex).mixed(0.8, with: Tokens.ink))
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.6)
            // ALWAYS two lines of box, whatever it holds. The card's height is
            // then the same from "Open" through to a name that wraps, so the
            // dock cannot jump when someone called "Alexandra Smith" joins.
            //
            // THE BOX IS THE FONT'S, not a guess at it. This was `size * 1.15 * 2`
            // — a made-up 1.15 leading — and Fredoka is taller than that,
            // so the glyphs overflowed a box too short for them and every label
            // on the dock was cut off at the baseline. "Open" and every player
            // name, on every screenshot this shell has taken.
            //
            // `lineHeight` asks the font. `fixedSize(vertical:)` then stops a
            // squeezed parent from taking the space back: the dock sits under a
            // greedy top band, and a VStack under pressure compresses its
            // children rather than overflowing.
            .fixedSize(horizontal: false, vertical: true)
            .frame(height: Fonts.lineHeight(Self.nameSize, weight: .bold) * 2)
    }

    @ViewBuilder
    private var background: some View {
        let shape = RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)
        if seat.open {
            // `.seat--open`: a GLASS placeholder of the same footprint, visibly
            // a slot rather than a card. The web blurs behind it as well; this
            // is the tint alone, over the live attract race.
            shape.fill(Tokens.glass(alpha: 0.28))
        } else {
            shape.fill(Tokens.surface)
        }
    }

    /// The two corner markers are MUTUALLY EXCLUSIVE by the model's rule — the
    /// host never readies — so they share one slot and this view arbitrates
    /// nothing. The web relies on the same fact (its CSS pins both to the same
    /// corner and simply lets them not collide).
    ///
    /// Hung `top: -0.6rem; right: -0.55rem` off the card, measured to the disc;
    /// the white ring round it (`box-shadow: 0 0 0 3px #fff`) is extra.
    @ViewBuilder
    private var marker: some View {
        if seat.host {
            disc(Image(systemName: "star.fill").font(.system(size: 14)), fill: Tokens.ink)
                .accessibilityLabel(Copy.host)
        } else if seat.ready {
            disc(Image(systemName: "checkmark").font(.system(size: 14, weight: .heavy)), fill: Tokens.green)
                .accessibilityLabel(Copy.ready)
        }
    }

    /// SF Symbols stands in for the web's inline SVG paths: a white glyph on a
    /// 26-point disc, ringed in white so it reads off the card's corner.
    private func disc(_ glyph: some View, fill: Color) -> some View {
        glyph
            .foregroundStyle(.white)
            .frame(width: 26, height: 26)
            .background(Circle().fill(fill))
            .padding(3)
            .background(Circle().fill(.white))
            .offset(x: 9 + 3, y: -10 - 3)
    }
}

// MARK: - Metrics shared by two cards

/// The two rails, and the inner width each leaves its content.
///
/// Constants rather than a `GeometryReader`, because the widths ARE constants
/// here: tvOS is always 1920x1080 POINTS whatever the box outputs (ledger 2.6),
/// so the web's `clamp()`s each resolve to one number — the same numbers
/// Android's `LobbyScreen` resolves them to, so the three boards match. A reader
/// would also make the QR's size depend on a layout pass that has not happened
/// on the first frame, which is the pop the web's `aspect-ratio` reservation
/// exists to avoid.
private enum LobbyViewMetrics {
    /// The board's overscan margin, `--safe-frac-x/y` of the 1920x1080 canvas.
    static let safeX: CGFloat = Tokens.number("safe-frac-x") * 1920
    static let safeY: CGFloat = Tokens.number("safe-frac-y") * 1080
    static let cardPadding: CGFloat = 16
    /// `.ticket`'s `padding: 0.85rem` — a thin paper margin, so the QR fills the card.
    static let ticketPadding: CGFloat = 14
    /// The two rails, `min(clamp(240px, 26vw, 440px), 38vh)` and
    /// `min(clamp(220px, 24vw, 460px), 32vh)` at 1920x1080.
    static let ticketWidth: CGFloat = 410
    static let cupWidth: CGFloat = 346
    /// `.ticket__urlbox`'s type scale; the room code is 1.45em of it.
    static let urlSize: CGFloat = 17
    /// What is left inside each card. The QR takes the whole of the ticket's.
    static let ticketInner: CGFloat = ticketWidth - 2 * ticketPadding
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
