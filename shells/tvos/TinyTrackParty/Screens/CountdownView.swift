import SwiftUI

/// The two pieces of race chrome that are not per-cell: the countdown and the
/// pause overlay.
///
/// The countdown floats BARE over the live 3D view — no paper stage, no panel
/// behind it. The pause overlay is FROST, the one surface for every full-screen
/// layer. Everything below renders from `GameState`; none of it decides
/// anything.

// MARK: - The countdown

/// The beat on a white paper DISC, tipped a few degrees like a toy's dial, and
/// the whole count under it on a GLASS strip with the current beat lit. GO!
/// turns the disc green.
///
/// The string is already resolved: `ttp_race_countdown_tick_json` answers a beat
/// number, `Copy.countdown` turns it into text, and the race-flow performer puts
/// the result in `GameState.countdown` (nil is "the countdown is gone"). Nothing
/// here counts, and nothing here decides when GO happens — the beat's SOUND is
/// the wasm's too, tapped where the tick fires.
///
/// Sizes are the CSS's `vh`, which on a 1080-point screen is one number each:
/// tvOS is always 1920x1080 POINTS whatever the box outputs.
struct CountdownView: View {

    /// `GameState.countdown`.
    let text: String?
    /// How many beats the strip lays out before GO: the launch's own count,
    /// `COUNTDOWN_SECONDS` off the manifest, as the web's `paintSteps` reads it.
    let steps: Int

    /// `34vh`, and `24vh` / `13vh` for the numeral and for GO!.
    private static let disc: CGFloat = 367
    private static let digit: CGFloat = 259
    private static let goSize: CGFloat = 140

    /// `6.4vh` cells (GO's `9vh` wide) on `0.8vh` gaps inside `1vh` of padding,
    /// in `2.8vh` type, `4vh` clear of the safe edge.
    private static let step: CGFloat = 69
    private static let goStep: CGFloat = 97
    private static let stepGap: CGFloat = 9
    private static let stripPad: CGFloat = 11
    private static let stepType: CGFloat = 30
    private static let stripLift: CGFloat = 43

    /// Drives the GO! fade. A one-shot per countdown, reset by `.task(id:)`.
    @State private var goFaded = false

    private var isGo: Bool { text == Copy.go }

    /// The beat as a number, to light its cell: the digit, or 0 for GO.
    private var beat: Int { isGo ? 0 : Int(text ?? "") ?? -1 }

    var body: some View {
        if let text {
            ZStack {
                // FLATTEN BEFORE ANIMATING. Animating the opacity of a live
                // composited tree over the 4K Metal surface re-rasterizes it per
                // frame, and at 4K that compositing lands OUTSIDE anything the
                // renderer can see: the old die-cut numeral cost the A10X
                // 60 -> 7 fps for exactly the second the GO! fade ran. Each
                // piece is rasterized once, so the fade is a texture transform.
                face(text).drawingGroup()
                    // `margin-top: -4vh`: the disc sits a little above centre.
                    .offset(y: -43)
                strip.drawingGroup()
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, Self.stripLift)
            }
            // `#countdown.is-go`: GO! stays up the beat AFTER the start (the
            // cars are already moving) and fades out over that ~1s window. A
            // PLAIN FADE, no grow — the scale was the expensive half and earned
            // nothing the fade does not. The digits carry no animation at all:
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

    private func face(_ text: String) -> some View {
        Text(text)
            .font(Fonts.display(isGo ? Self.goSize : Self.digit, weight: .bold))
            .foregroundStyle(isGo ? .white : Tokens.ink)
            .fixedSize()
            // `margin-top: -1.5vh` on the numeral, which the disc centres; and a
            // "1" centred by its box reads right of centre — its flag reaches
            // left, so its stem sits right of the middle — so it moves left
            // until the stem is near the centre (`translate: -0.045em`).
            .offset(x: beat == 1 ? -0.045 * Self.digit : 0, y: isGo ? 0 : -8)
            .frame(width: Self.disc, height: Self.disc)
            .background(Circle().fill(isGo ? Tokens.brand : Tokens.surface))
            .rotationEffect(.degrees(-4))
    }

    private var strip: some View {
        HStack(spacing: Self.stepGap) {
            ForEach(Array(stride(from: steps, through: 0, by: -1)), id: \.self) { n in
                let now = n == beat
                Text(n > 0 ? String(n) : Copy.goStep)
                    .font(Fonts.display(Self.stepType, weight: .bold))
                    .foregroundStyle(now ? (n == 0 ? .white : Tokens.ink) : Color.white.opacity(0.7))
                    // The strip's "1" takes the same nudge as the disc's.
                    .offset(x: n == 1 ? -0.045 * Self.stepType : 0)
                    .frame(width: n == 0 ? Self.goStep : Self.step, height: Self.step)
                    .background(Capsule().fill(now ? (n == 0 ? Tokens.brand : Color.white)
                                                   : Color.white.opacity(0.14)))
            }
        }
        .padding(Self.stripPad)
        // GLASS without the web's backdrop blur, as the race HUD's lap pill:
        // the live race is behind it, and the tint alone carries the type.
        .background(Capsule().fill(Tokens.glass))
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
