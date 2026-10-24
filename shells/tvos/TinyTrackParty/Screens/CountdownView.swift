import SwiftUI

/// The two pieces of race chrome that are not per-cell: the countdown and the
/// pause overlay.
///
/// The countdown floats BARE over the live 3D view — no paper stage, no panel
/// behind it. The pause overlay is FROST, the one surface for every full-screen
/// layer. Everything below renders from `GameState`; none of it decides
/// anything.

// MARK: - The countdown

/// START LIGHTS along the top of every player's view: the whole count on a
/// GLASS strip, the current beat lit a size up, GO green.
///
/// ONE STRIP PER CELL, at the TOP, in every player count, as the web's
/// `placeViews`: a count in the middle of the picture always lands on a car,
/// since each player's car sits low in the middle of their own view. The strip
/// is sized off its cell's height, so it keeps its share of the 3D picture in
/// a lone view and in a split alike, and its top is level with the name chip
/// and the place badge, which hang the same margin under the safe edge.
///
/// The string is already resolved: `ttp_race_countdown_tick_json` answers a beat
/// number, `Copy.countdown` turns it into text, and the race-flow performer puts
/// the result in `GameState.countdown` (nil is "the countdown is gone"). Nothing
/// here counts, and nothing here decides when GO happens — the beat's SOUND is
/// the wasm's too, tapped where the tick fires.
struct CountdownView: View {

    /// `GameState.countdown`.
    let text: String?
    /// How many beats the strip lays out before GO: the launch's own count,
    /// `COUNTDOWN_SECONDS` off the manifest, as the web's `paintSteps` reads it.
    let steps: Int

    /// `GameState.countdownCupRace`: the cup line hung under each strip, nil
    /// outside a cup.
    let cupRace: GameState.CupRaceLine?

    /// Every cell's PICTURE rect and SAFE rect (`GameState.CellHUD`): a strip
    /// centred on the picture, hung from the safe edge. Empty is the whole
    /// screen.
    let cells: [(rect: CGRect, safe: CGRect)]

    /// `display.css`'s `--light`: one light's diameter as a fraction of the
    /// cell's height. Everything else on the strip is a multiple of it: GO's
    /// width, the gap, the padding, the type, and the lit beat's size up.
    private static let light: CGFloat = 0.128
    private static let goWidth: CGFloat = 1.4
    private static let gap: CGFloat = 0.125
    private static let pad: CGFloat = 0.156
    private static let type: CGFloat = 0.44
    private static let litScale: CGFloat = 1.15
    private static let raceTop: CGFloat = 1.47
    private static let raceType: CGFloat = 0.27

    /// Drives the GO fade. A one-shot per countdown, reset by `.task(id:)`.
    @State private var goFaded = false

    private var isGo: Bool { text == Copy.go }

    /// The beat as a number, to light its cell: the digit, or 0 for GO.
    private var beat: Int { isGo ? 0 : Int(text ?? "") ?? -1 }

    var body: some View {
        if text != nil {
            // FLATTEN BEFORE ANIMATING. Animating the opacity of a live
            // composited tree over the 4K Metal surface re-rasterizes it per
            // frame, and at 4K that compositing lands OUTSIDE anything the
            // renderer can see: the old die-cut numeral cost the A10X
            // 60 -> 7 fps for exactly the second the GO fade ran. Each strip is
            // rasterized once, so the fade is a texture transform.
            GeometryReader { geo in
                let whole = CGRect(origin: .zero, size: geo.size)
                let boxes = cells.isEmpty ? [(rect: whole, safe: whole)] : cells
                ForEach(boxes.indices, id: \.self) { i in
                    let b = boxes[i]
                    let l = Self.light * b.rect.height
                    // `.position` centres the strip on the point, so its top
                    // lands half its height above it.
                    strip(lightSize: l).drawingGroup()
                        // `.cd-race`: its top 1.47 lights under the strip's,
                        // clear of the lit beat's size up. An overlay, so the
                        // strip keeps its place with or without it.
                        .overlay(alignment: .top) {
                            if let cupRace {
                                cupLine(cupRace, lightSize: l).fixedSize().drawingGroup()
                                    .offset(y: Self.raceTop * l)
                            }
                        }
                        .position(x: b.rect.midX, y: b.safe.minY + RaceHUDView.cellMargin + l * (0.5 + Self.pad))
                }
            }
            // The rects describe the SURFACE, whose origin is the screen's
            // (RaceHUDView places its chips on the same ones).
            .ignoresSafeArea()
            // `#countdown.is-go`: GO stays up the beat AFTER the start (the
            // cars are already moving) and fades out over that ~1s window. A
            // PLAIN FADE, no grow — the scale was the expensive half and earned
            // nothing the fade does not. The beats carry no animation at all:
            // a beat that moves reads as a beat still counting.
            .opacity(isGo && goFaded ? 0 : 1)
            .animation(isGo ? .easeOut(duration: 1) : nil, value: goFaded)
            .task(id: text) {
                goFaded = false
                if isGo { goFaded = true }
            }
            .allowsHitTesting(false)
        }
    }

    private func strip(lightSize l: CGFloat) -> some View {
        HStack(spacing: Self.gap * l) {
            ForEach(Array(stride(from: steps, through: 0, by: -1)), id: \.self) { n in
                let now = n == beat
                Text(n > 0 ? String(n) : Copy.goStep)
                    .font(Fonts.display(Self.type * l, weight: .bold))
                    .foregroundStyle(now ? (n == 0 ? .white : Tokens.ink) : Color.white.opacity(0.7))
                    // A "1" centred by its box reads right of centre: its flag
                    // reaches left, so its stem sits right of the middle.
                    .offset(x: n == 1 ? -0.045 * Self.type * l : 0)
                    .frame(width: n == 0 ? Self.goWidth * l : l, height: l)
                    .background(Capsule().fill(now ? (n == 0 ? Tokens.brand : Color.white)
                                                   : Color.white.opacity(0.14)))
                    .scaleEffect(now ? Self.litScale : 1)
            }
        }
        .padding(Self.pad * l)
        // GLASS without the web's backdrop blur, as the race HUD's lap pill:
        // the live race is behind it, and the tint alone carries the type.
        .background(Capsule().fill(Tokens.glass))
    }

    /// The cup line in the lap pill's GLASS type; a cup's last race in red.
    private func cupLine(_ line: GameState.CupRaceLine, lightSize l: CGFloat) -> some View {
        let size = Self.raceType * l
        return Text(line.text.uppercased())
            .font(Fonts.display(size, weight: .semibold))
            .tracking(size * 0.12)
            .foregroundStyle(.white)
            .lineLimit(1)
            .padding(.vertical, size * 0.3)
            .padding(.horizontal, size * 0.95)
            .background(Capsule().fill(line.final ? Tokens.red.opacity(0.8) : Tokens.glass))
    }
}

// MARK: - The pause overlay

/// FROST over the frozen race, with the title and the two choices straight on
/// it — no card. A pause on the TV and on a phone are one screen.
///
/// **The freeze itself is not here.** `ttp_ui_freeze_transition` is the ONE
/// writer of `ttp_pause`/`ttp_resume`, the display hold and the music pause, and
/// the coordinator performs its answer (`syncSessionFrozen`). This view is the
/// two buttons and the frost.
struct PauseOverlay: View {

    /// Resume. The caller owns the gate (`ttp_ui_can_resume`) and the three
    /// writes that follow it.
    let onContinue: () -> Void
    /// Quit to the lobby. A mid-race quit, and it cancels a cup too — which is
    /// `ttp_race_return_json`'s answer to make, not this view's.
    let onNewGame: () -> Void

    private enum Control: Hashable { case resume, quit }
    @FocusState private var focus: Control?

    /// `.pause-card h2` (4.6rem) and the overlays' TV-size buttons
    /// (`clamp(1.25rem, 2.3vw, 1.9rem)`) on a 1920-wide board.
    static let titleSize: CGFloat = 74
    static let buttonSize: CGFloat = 30

    var body: some View {
        ZStack {
            // Only the FROST reaches past the safe area. The buttons stay
            // inside it, because a TV's overscan is real and a button under the
            // bezel is a button nobody can press.
            Frost()

            VStack(spacing: 32) {
                Text(Copy.paused)
                    .font(Fonts.display(Self.titleSize, weight: .bold))
                    .foregroundStyle(Tokens.ink)
                // The pair is always one size (`min-width: 9em`), so a label
                // that outgrows it widens both rather than one. Wider apart than
                // the web's 1rem: the focused one lifts and wears its ring 7
                // points out, and at 16 the ring touched its neighbour.
                HStack(spacing: 28) {
                    StickerButton(Copy.continueLabel, tint: Tokens.brand,
                                  size: Self.buttonSize, minWidth: Self.buttonSize * 9,
                                  action: onContinue)
                        .focused($focus, equals: .resume)
                    // `.btn--ghost`: a CHOICE, white with the faint edge and ink
                    // type — the web's own quiet secondary. An ink-FILLED
                    // primary here put the darkest value in the palette next to
                    // the green Continue, which reads as the louder of the two.
                    StickerButton(Copy.newGameLabel, size: Self.buttonSize, ghost: true,
                                  minWidth: Self.buttonSize * 9, action: onNewGame)
                        .focused($focus, equals: .quit)
                }
            }
        }
        // Continue is the default: the overlay exists because someone wants to
        // carry on, and on a TV the first click has to land on the harmless
        // option. `defaultFocus` rather than an `onAppear` write, because it
        // runs when the focus system ESTABLISHES focus here and again after
        // every reset, so it cannot lose the race the manual version can.
        .defaultFocus($focus, .resume)
    }
}
