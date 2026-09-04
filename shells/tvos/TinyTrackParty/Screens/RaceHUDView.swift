import SwiftUI

/// The per-cell race chrome: name chip, item slot, place/lap readout, the
/// FINISHED card and the reconnect card.
///
/// **EVERYTHING IS PLACED FROM `GameState.CellHUD`'s two rects, and nothing
/// else** — `rect` for what is centred on the picture, `safeRect` for what hangs
/// off an edge a television may be cropping (see `CellChrome`).
/// The first is `ttp_display_cell_rects`' answer divided back to points by
/// `DisplayHost` — the LETTERBOXED cell (`cellRectTopLeft`, capped at
/// `CELL_MAX_ASPECT` and centred as one piece), which is where the camera
/// actually rendered. A grid computed here, or the view's own bounds divided by
/// the cell count, is a second opinion and it will disagree: the renderer's own
/// steer bar drew off the RAW `ttp_grid_cell` tiling until 2026-07-29 and every
/// bar sat a fifth of a cell off, under a car that was not there. It is not an
/// ultrawide-only bug either — the 2-PLAYER layout is stacked, so its cells are
/// 3.56:1 and past the cap in ordinary play.
///
/// **WHAT THIS FILE MAY NOT DRAW.** The steer bar and the cell dividers are the
/// RENDERER's (`materials/voverlay.mat`, `TtpCellHudInput`), from these same
/// rects. Drawing them here would double them, and the second copy would drift.
/// The line is exact and worth keeping in mind before adding anything:
/// **cell-anchored AND textless goes to the renderer; anything carrying type or
/// sticker chrome stays here.** That is why the bar and the dividers are there
/// and the place ordinal, the name chip, the item slot, the FINISHED card and
/// the reconnect QR are here.
///
/// Chrome over the live race view floats BARE — no `PaperStage`, no panel. Paper
/// backgrounds are for full-screen boards only (`theme.css`, and `Sticker.swift`
/// says it from the other side).
///
/// Nothing in here is focusable. A TV's focus engine drives the whole UI, and a
/// HUD element that could take focus would steal it from the pause overlay and
/// the results button, which are the only things on this screen a remote is
/// meant to reach.
struct RaceHUDView: View {

    /// One per split-screen cell, in the order `ttp_display_cells` named them.
    /// Rebuilt by the coordinator's ~6 Hz poll, not per frame: nothing here
    /// changes at 60 Hz since the steer bar moved into the renderer.
    let cells: [GameState.CellHUD]

    /// The BOOST icon's chevron accent for the biome this scene resolved to
    /// (`ttp_theme_boost_icon`, 0xRRGGBB — `ItemIcon` substitutes it into the
    /// shared SVG). Threaded down rather than read from a token: `Tokens` has
    /// no biome in it, and the accent is picked for contrast with THIS track's
    /// deck.
    let boostAccent: UInt32

    /// `GameState.itemPickupTick` — bumped by the coordinator's `item-pickup`
    /// effect, keyed by identity. Threaded as the PUBLISHED map rather than
    /// baked into `CellHUD`, because `cells` is rebuilt by the ~6 Hz poll and a
    /// baked tick would land up to a poll interval after the pickup it triggers.
    let itemPickupTick: [EngineIdentity: Int]

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(cells) {
                CellChrome(cell: $0, boostAccent: boostAccent,
                           itemTick: itemPickupTick[$0.car] ?? 0)
            }
        }
        // The rects describe the SURFACE, whose origin is the screen's, so this
        // layer has to span the same box. A safe-area inset here would shift
        // every chip by the TV's overscan margin away from the picture it
        // labels — the same failure as placing off the wrong grid, arriving by a
        // different road.
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

// MARK: - One cell

/// The chrome for a single cell, laid out INSIDE a box that is exactly the cell
/// rect. Each element's anchor is then an alignment rather than an arithmetic
/// offset, which is the same contract §3.4 states in coordinates:
///
///   name chip + item slot   (r.x, r.y) top-left      unless reconnecting
///   place / lap             (r.x + r.w - 12, r.y + 11) top-right,
///                                                    unless finished || reconnecting
///   FINISHED card           centre of r              when finished
///   reconnect QR card       centre of r              when reconnecting && !finished
private struct CellChrome: View {
    let cell: GameState.CellHUD
    let boostAccent: UInt32
    /// This car's pickup counter, already resolved from the map by the caller.
    let itemTick: Int

    /// `.cell-label`'s `margin: 0.7rem`. Points, not pixels: tvOS is always
    /// 1920x1080 POINTS whatever the box outputs, and the web's chrome is
    /// authored against a ~1920 CSS px viewport, so the number transfers.
    private static let margin: CGFloat = 11

    /// FINISHED wins the cell if a car is somehow both finished and dropped.
    /// The coordinator already resolves that when it builds the row (it hands
    /// back `reconnecting && !finished`), so this is the rule stated a second
    /// time where the card is actually drawn rather than a second decision — and
    /// it is what keeps this view correct if it is ever handed a raw row.
    private var showsReconnect: Bool { cell.reconnecting && !cell.finished }
    private var cardInCell: Bool { cell.finished || showsReconnect }

    /// TWO BOXES, on the cell's two rects, because the chrome divides cleanly
    /// into two kinds and they want different ones.
    ///
    /// The chips hang off a CORNER, and a corner is exactly what a television
    /// that overscans crops — so they measure from `safeRect`, and their authored
    /// margins are then margins from the safe edge. The cards are CENTRED, and
    /// what they are centred on is the picture: pulling them into the safe rect
    /// would shift them off the middle of the very thing they are covering, in
    /// any cell with one outer edge.
    var body: some View {
        ZStack {
            ZStack(alignment: .topLeading) {
                if !cell.reconnecting {
                    // Hidden under the reconnect card because that card already
                    // shows the name, so the chip would just repeat it. The
                    // FINISHED card carries no name, so it keeps the chip.
                    cornerLabel.padding(Self.margin)
                }
                if !cardInCell {
                    rankReadout
                        .padding(.top, Self.margin)
                        .padding(.trailing, 12)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                }
            }
            .frame(width: cell.safeRect.width, height: cell.safeRect.height)
            // `.position` centres its subject on the point, so the box lands
            // exactly on the rect it was given.
            .position(x: cell.safeRect.midX, y: cell.safeRect.midY)

            if cell.finished {
                FinishedCard(cell: cell)
                    .position(x: cell.rect.midX, y: cell.rect.midY)
            } else if showsReconnect {
                ReconnectCard(name: cell.name, url: cell.reconnectURL)
                    .position(x: cell.rect.midX, y: cell.rect.midY)
            }
        }
    }

    // MARK: Top-left — the name chip over the item slot

    private var cornerLabel: some View {
        // `.cell-label__row`: column, left-aligned, 0.5rem gap.
        VStack(alignment: .leading, spacing: 8) {
            NameChip(name: cell.name, colorIndex: cell.colorIndex)
            ItemSlot(item: cell.item, boostAccent: boostAccent,
                     carIndex: cell.carIndex, tick: itemTick)
        }
        // `.cell-label__name`'s `max-width: 14em`, imposed HERE rather than on
        // the chip. A `maxWidth` frame in SwiftUI FILLS to its maximum, so
        // putting it on the chip would stretch the sticker to 490 points behind
        // a three-letter name; putting it on the column instead leaves the chip
        // shrink-wrapped (Text takes the smaller of its ideal and the proposal)
        // and still truncates a long name rather than letting it run across the
        // cell into the next player's picture.
        .frame(maxWidth: NameChip.maxTextWidth, alignment: .leading)
    }

    // MARK: Top-right — place over lap

    /// `.cell-rank`: a white sticker badge for the ordinal over an ink
    /// "LAP 2/3" pill, the pair right-aligned and leaning +1.5°.
    private var rankReadout: some View {
        VStack(alignment: .trailing, spacing: 7) {
            // A cell whose car has no live HUD row this tick reports 0 — that
            // is `DisplayHost.hud()` SKIPPING a slot no live car claims, which
            // is what stops a Grand Prix swapping tracks under the HUD from
            // painting "0th, lap 0". The web never wrote those strings because
            // it painted per ROW; this shell paints per CELL, so the guard lives
            // here instead.
            if cell.place > 0 {
                Text(Copy.ordinal(cell.place))
                    .font(Fonts.display(46, weight: .bold))
                    .foregroundStyle(Tokens.ink)
                    .padding(.vertical, 10)
                    .padding(.horizontal, 21)
                    .background(
                        RoundedRectangle(cornerRadius: Sticker.radiusSmall, style: .continuous)
                            .fill(Tokens.surface)
                            .hardShadow(Sticker.popShadow)
                    )
                    .stickerOutline(Sticker.border, radius: Sticker.radiusSmall)
            }
            if cell.totalLaps > 0 {
                StickerPill(Copy.lap(cell.lap, of: cell.totalLaps), tint: Tokens.ink, size: 18)
            }
        }
        .rotationEffect(.degrees(1.5))
    }
}

// MARK: - The name chip

/// `.cell-label__name` — the player's name on a sticker FILLED with their livery,
/// white text. Filled rather than livery text on white (which this was, and which
/// the phone never did): across a four-way split the thing you hunt for is your
/// own cell, and a solid block of your colour is found in peripheral vision where
/// coloured GLYPHS are not.
private struct NameChip: View {
    let name: String
    let colorIndex: Int

    /// `clamp(1.5rem, 2vw, 2.2rem)` against a 1920-wide display: 2vw is 38, so
    /// the clamp lands on its 2.2rem ceiling.
    private static let size: CGFloat = 35

    /// `max-width: 14em`, applied by the caller — see `cornerLabel`.
    static let maxTextWidth: CGFloat = 35 * 14

    var body: some View {
        Text(name)
            .font(Fonts.display(Self.size, weight: .bold))
            .foregroundStyle(.white)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.vertical, Self.size * 0.3)
            .padding(.horizontal, Self.size * 0.55)
            .background(
                RoundedRectangle(cornerRadius: Sticker.radiusSmall, style: .continuous)
                    .fill(Tokens.car(colorIndex))
                    .hardShadow(Sticker.popShadow)
            )
            .stickerOutline(Sticker.border, radius: Sticker.radiusSmall)
            .rotationEffect(.degrees(-2))
    }
}

// MARK: - The item slot

/// The held-item slot: a FIXED reserved square (so nothing reflows when it is
/// empty) that SLOT-MACHINES on every pickup.
///
/// **A fresh pickup re-spins even on the same item id.** A box swap can re-roll
/// what you already had, and a slot that only animated on CHANGE would say
/// nothing at all on that pickup — so the trigger is the pickup, not the value.
/// `GameState.itemPickupTick` is the counter the coordinator bumps for exactly
/// this (`item-pickup`, `GameCoordinator.itemPickup`), found through
/// `CellHUD.car` — never the name, which two players may share.
private struct ItemSlot: View {
    /// `ttp_item_id`'s key for the held item, or nil for an empty slot. Already
    /// nil while finished — the model clears it, this view does not test it.
    let item: String?
    /// The boost chevrons' accent, from `ttp_theme_boost_icon`. The other
    /// three icons ignore it.
    let boostAccent: UInt32
    /// This cell's car MODEL index — the monster chip's `--icon-car` body
    /// tone. The other three icons ignore it.
    let carIndex: Int
    /// This car's `itemPickupTick` entry, bumped once per fresh pickup.
    let tick: Int

    /// `clamp(112px, 10vw, 152px)` on a 1920-wide display: 10vw is 192, so the
    /// clamp lands on its 152 ceiling. VIEWPORT width, not cell width — the slot
    /// is the same size in a four-way split as it is full screen, exactly as on
    /// the web.
    private static let side: CGFloat = 152
    private static let corner: CGFloat = 26

    /// Which key the roulette is showing right now, or nil when it is resting on
    /// `item`.
    @State private var rolling: String?
    /// Bumped when a spin LANDS, which is what fires the pop track.
    @State private var landed = 0

    private var shown: String? { rolling ?? item }

    /// `cellItemRoll` and `cellItemPop`, as the two things they are in the CSS:
    /// a repeating track while the slot rolls, and a one-shot on the landing.
    private struct Pose: Equatable {
        var scale: CGFloat = 1
        var tilt: Double = 0
        /// CSS `filter: brightness()` MULTIPLIES and SwiftUI's `.brightness`
        /// ADDS, so these are the same gesture at a comparable strength rather
        /// than the same number. Dropping it entirely is what made the roll read
        /// as a wobble instead of a slot machine — the strobe is half of it.
        var bright: Double = 0
    }

    var body: some View {
        ZStack {
            if let key = shown {
                RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                    .fill(Tokens.surface)
                    .hardShadow(Sticker.popShadow)
                    .overlay(
                        RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                            .strokeBorder(Tokens.ink, lineWidth: Sticker.border)
                    )
                    .overlay(icon(key))
            } else {
                // The empty slot: `border: 4px dashed color-mix(ink 45%,
                // transparent)`, no fill and no shadow, so it reads as a
                // reserved space rather than as a sticker.
                RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                    .strokeBorder(Tokens.ink.opacity(0.45),
                                  style: StrokeStyle(lineWidth: Sticker.border, dash: [10, 8]))
            }
        }
        .frame(width: Self.side, height: Self.side)
        // `cellItemRoll`: 0.1s linear INFINITE, between scale(1.12) rotate(-4)
        // brightness(1.2) and scale(0.97) rotate(4) brightness(0.9).
        //
        // A KEYFRAME TRACK rather than a `withAnimation` toggle, and the reason
        // is the same one that makes this file readable next to `display.css`:
        // the CSS is a keyframe list, so this is a keyframe list. The version
        // before it drove the two poses off each icon swap, which animated for
        // 50 ms and then froze for up to 113 — the stutter that read as dropped
        // frames. The version before THAT held them still.
        //
        // `initialValue` is the RESTING pose, because that is what the animator
        // returns to when `repeating` goes false.
        .keyframeAnimator(initialValue: Pose(), repeating: rolling != nil) { view, p in
            view.scaleEffect(p.scale).rotationEffect(.degrees(p.tilt)).brightness(p.bright)
        } keyframes: { _ in
            KeyframeTrack(\.scale) {
                MoveKeyframe(1.12)
                LinearKeyframe(0.97, duration: 0.05)
                LinearKeyframe(1.12, duration: 0.05)
            }
            KeyframeTrack(\.tilt) {
                MoveKeyframe(-4)
                LinearKeyframe(4, duration: 0.05)
                LinearKeyframe(-4, duration: 0.05)
            }
            KeyframeTrack(\.bright) {
                MoveKeyframe(0.10)
                LinearKeyframe(-0.06, duration: 0.05)
                LinearKeyframe(0.10, duration: 0.05)
            }
        }
        // `cellItemPop`: 0.5s, scale 1.8 -> 1 and brightness 1.6 -> 1.15 -> 1.
        //
        // STARTING AT 1.8 is the part that needs a track. SwiftUI animates
        // FROM the current value, so "jump big, then settle" was two writes a
        // frame apart — which rendered a 20 ms hold at full size that the web
        // does not have. `MoveKeyframe` sets it with no frame of its own.
        //
        // The two never overlap: the web removes `.rolling` as it adds `.pop`,
        // and here `rolling` is nil by the time this fires, so the track above
        // is already back at rest.
        .keyframeAnimator(initialValue: Pose(), trigger: landed) { view, p in
            view.scaleEffect(p.scale).brightness(p.bright)
        } keyframes: { _ in
            KeyframeTrack(\.scale) {
                MoveKeyframe(1.8)
                SpringKeyframe(1, duration: 0.5, spring: .init(duration: 0.35, bounce: 0.35))
            }
            KeyframeTrack(\.bright) {
                MoveKeyframe(0.30)
                LinearKeyframe(0.08, duration: 0.30)
                LinearKeyframe(0, duration: 0.20)
            }
        }
        .task(id: Trigger(item: item, tick: tick)) { await spin() }
    }

    private struct Trigger: Equatable {
        let item: String?
        let tick: Int
    }

    /// The web's `_rouletteChip`, beat for beat: flick through the item keys,
    /// decelerating, then land on the real item with a pop. Self-driven because
    /// it animates far faster than the ~6 Hz HUD poll that feeds this view.
    @MainActor
    private func spin() async {
        // Nothing to spin to: the slot was used, so it just goes back to empty.
        guard item != nil, !ItemVocabulary.keys.isEmpty else {
            rolling = nil
            return
        }
        // 8 flicks then land, at 35 + 16n ms each: 51, 67 … 163. The
        // deceleration is what makes it read as a slot machine coming to rest
        // rather than as a flicker. `_rouletteChip`'s own schedule.
        for n in 1...8 {
            rolling = ItemVocabulary.keys[(n - 1) % ItemVocabulary.keys.count]
            try? await Task.sleep(nanoseconds: UInt64(35 + n * 16) * 1_000_000)
            // A cancelled spin (the item changed mid-roll) just stops: both
            // tracks return to their resting pose on their own, which is the
            // whole reason there is no state to put back any more.
            if Task.isCancelled { rolling = nil; return }
        }
        rolling = nil
        landed += 1
    }

    /// What a filled slot shows: the ICON.
    ///
    /// This printed the WORD — "BANANA", in a 152-point square — because three
    /// of the web's four icons were inline SVG and `stage-assets.sh` staged
    /// none of them. Both halves of that are gone: `bake-item-icons.mjs` is one
    /// source for all four, and the PNGs ship.
    ///
    /// It mattered more than a label swap sounds. The slot is glanced at from a
    /// sofa, in a corner of a quarter-screen, by somebody steering — which is
    /// the one situation where a word is strictly worse than a picture. The
    /// roulette made it worse still: flicking through four WORDS reads as text
    /// corrupting, not as a slot machine.
    ///
    /// One padding for all four — the web sizes every inlined SVG to 70% of
    /// its chip for the same reason (`.cell-label__item svg`).
    private func icon(_ key: String) -> some View {
        ItemIcon(key: key, accent: boostAccent, carIndex: carIndex)
            .padding(Self.side * 0.15)
    }
}

/// The item vocabulary, DERIVED from the ABI rather than mirrored.
///
/// `ttp_item_id(code)` names the id a box roll can yield for `TTP_ITEM_BOOST`
/// (1) through `TTP_ITEM_MONSTER` (4) and answers NULL past the end, so walking
/// it is the same move the audio device makes for its cue table. The browser
/// keeps its own `ITEM_IDS` mirror in `engine/contract.js` and pays for it with
/// a test that exists only to hold the two lists together; a shell that walks
/// the export cannot drift in the first place.
///
/// Not private: `ItemIcon.prewarm` walks the same list, and a second spelling of
/// "which items exist" is exactly what deriving it was for.
@MainActor
enum ItemVocabulary {
    static let keys: [String] = {
        var out: [String] = []
        var code: Int32 = 1
        // The bound is a guard against a corrupt artifact answering non-NULL
        // forever, not a claim about how many items there are.
        while code < 64, let id = TTP.str(ttp_item_id(code)) {
            out.append(id)
            code += 1
        }
        return out
    }()
}

// MARK: - The FINISHED card

/// Centred in the player's own cell the instant they cross the line, while the
/// rest of the field is still racing. Both of its values are fixed at that
/// moment, so this card is written once and then left alone.
///
/// The steer bar under it goes at the same time, one layer down: same predicate,
/// pushed to the renderer as `ttp_display_cell_cards`' bitmask by the
/// coordinator BEFORE the frame draws.
private struct FinishedCard: View {
    let cell: GameState.CellHUD

    var body: some View {
        StickerCard(tint: Tokens.surface, rotation: -1.5, padding: 20) {
            VStack(spacing: 6) {
                StickerPill(Copy.finished, tint: Tokens.car(cell.colorIndex), size: 20)
                Text(Copy.ordinal(cell.place))
                    .font(Fonts.display(54, weight: .bold))
                    .foregroundStyle(Tokens.ink)
                if let time = finishTime {
                    Text(Copy.seconds(time))
                        .font(Fonts.body(22, weight: .heavy))
                        .foregroundStyle(Tokens.ink2)
                        .monospacedDigit()
                }
            }
        }
    }

    /// A car can be FINISHED with no recorded time — a forfeit resolved at the
    /// flag — and the card prints nothing rather than "0.0s" for it. The packed
    /// block keeps that distinction (`TTP_HUD_SLOT_TIMED`), and `CellHUD` carries
    /// it through as an optional rather than flattening it, so this is a
    /// pass-through and not a floor test.
    private var finishTime: Double? { cell.finishTime }
}

// MARK: - The reconnect card

/// A dropped player's rejoin QR, centred in their cell exactly like the FINISHED
/// card while their car keeps its place on track.
///
/// The URL is composed in C++ (`ttp_net_reconnect_card_json` over
/// `ttp_net_claim_url`) and carries `?claim=<peerIndex>`, which is what lets a
/// DIFFERENT device take the seat over. Only the bitmap is this platform's, and
/// that is decision D3, not a gap.
private struct ReconnectCard: View {
    let name: String
    let url: String?

    private static let qrSide: CGFloat = 132

    /// Rendered once per URL rather than per body. This view is rebuilt by the
    /// ~6 Hz HUD poll, and `CIQRCodeGenerator` is not something to run six times
    /// a second in a layout pass.
    @State private var code: CGImage?

    var body: some View {
        StickerCard(tint: Tokens.surface, rotation: -1.5, padding: 18) {
            VStack(spacing: 8) {
                Text(name)
                    .font(Fonts.display(22, weight: .semibold))
                    .foregroundStyle(Tokens.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: Self.qrSide + 44)
                Text(Copy.disconnected.uppercased())
                    .font(Fonts.display(16, weight: .semibold))
                    .tracking(0.4)
                    .foregroundStyle(Tokens.ink3)
                if let code {
                    Image(decorative: code, scale: 1)
                        // FILTERED, for the reason spelled out at the lobby
                        // ticket's own QR: this bitmap is ~800 px and the card
                        // is 160 points, so what happens to it is a heavy
                        // DOWNSCALE, and point-sampling a downscale throws away
                        // most of the source rather than preserving it. A
                        // thinned or merged module is unrecoverable by a
                        // decoder; a softened edge is not.
                        .interpolation(.high)
                        .antialiased(true)
                        .resizable()
                        .frame(width: Self.qrSide, height: Self.qrSide)
                        .clipShape(RoundedRectangle(cornerRadius: Sticker.radiusSmall,
                                                    style: .continuous))
                } else {
                    // Never a blank card: a dropped seat with no URL yet still
                    // says whose it is and that they are gone.
                    Color.clear.frame(width: Self.qrSide, height: 0)
                }
            }
        }
        .task(id: url) { code = url.flatMap { QRCode.image(for: $0) } }
    }
}
