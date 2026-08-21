import SwiftUI

/// The three pieces of race chrome that are not per-cell: the countdown banner,
/// the pause overlay, and the now-playing credit.
///
/// All three float BARE over the live 3D view — no paper stage, no panel behind
/// them (the pause overlay's frosted glass is the deliberate exception, and it
/// is a MODAL, which is the one thing paper is for). Everything below renders
/// from `GameState`; none of it decides anything.

// MARK: - The countdown banner

/// "3" / "2" / "1" / "GO!", die-cut across the middle of the screen.
///
/// The string is already resolved: `ttp_race_countdown_tick_json` answers a beat
/// number, `Copy.countdown` turns it into text, and the race-flow performer puts
/// the result in `GameState.countdown` (nil is "the banner is gone"). Nothing
/// here counts, and nothing here decides when GO happens — the beat's SOUND is
/// the wasm's too, tapped where the tick fires.
struct CountdownView: View {

    /// `GameState.countdown`.
    let text: String?

    /// `26vh` of a 1080-point screen. tvOS is always 1920x1080 POINTS whatever
    /// the box outputs, so the viewport unit resolves to one number here.
    private static let size: CGFloat = 281

    /// Drives the GO! fade. A one-shot per banner, reset by `.task(id:)`.
    @State private var goFaded = false

    private var isGo: Bool { text == Copy.go }

    var body: some View {
        if let text {
            DieCutText(text: text, size: Self.size)
                // FLATTEN BEFORE ANIMATING, and this line is worth more than it
                // looks. DieCutText is 17 stacked glyph layers under a shadow
                // filter, and animating over that re-rasterizes every one of
                // them per frame — at 4K the compositing that costs lands
                // OUTSIDE anything the renderer can see, so our GPU timer read
                // 9 ms of a 16.7 ms budget while the box missed four presents in
                // five. Measured on an A10X, solo at native 4K: the GO! beat
                // cost 60 -> 7 fps for exactly the second the fade below ran.
                // Rasterizing once turns the animation into a texture transform.
                .drawingGroup()
                // `#countdown.is-go`: GO! stays up the beat AFTER the start (the
                // cars are already moving) and fades out over that ~1s window.
                // A PLAIN FADE, no grow — the scale was the expensive half and
                // earned nothing the fade does not; the web dropped it in the
                // same change. The digits carry no animation at all on any
                // shell: a beat that moves reads as a beat still counting.
                .opacity(isGo && goFaded ? 0 : 1)
                .animation(isGo ? .easeOut(duration: 1) : nil, value: goFaded)
                .task(id: text) {
                    goFaded = false
                    if isGo { goFaded = true }
                }
                .allowsHitTesting(false)
        }
    }
}

/// Ink type with a thick white cut edge, the same technique (and for the same
/// reason) as `Sticker.swift`'s `Wordmark`: SwiftUI has no text stroke at all,
/// so the edge is white copies stamped around a ring behind the fill. The CSS
/// says `-webkit-text-stroke: 12px #fff` with `paint-order: stroke fill`, and
/// declares plain ink text an acceptable degradation where that is unsupported —
/// so this is a faithful reading, not a workaround.
private struct DieCutText: View {
    let text: String
    let size: CGFloat

    /// How far the white cut reaches OUTSIDE the glyph.
    ///
    /// **HALF the CSS number, and that is the whole of it.** A
    /// `-webkit-text-stroke` is CENTRED on the outline, so `12px` puts 6 outside
    /// and 6 under the fill — while these stamps are copies of the glyph offset
    /// by `edge`, whose union is the glyph DILATED by the full amount. Reading
    /// the stroke width straight across doubled the cut: a 24-point white halo
    /// round a 281-point numeral, which is what made the countdown look wrong
    /// rather than merely bold.
    ///
    /// 12/281 is the CSS's own proportion at the size this actually renders at
    /// (`-webkit-text-stroke: 12px` against `font-size: 26vh` on a 1080-point
    /// screen), halved for the convention above.
    private var edge: CGFloat { size * 0.0427 / 2 }

    /// Enough stamps that the edge round a chunky display face reads as one
    /// continuous cut rather than a ring of blobs.
    private static let samples = 16

    private struct Stamp: Identifiable {
        let id: Int
        let offset: CGSize
    }

    private var stamps: [Stamp] {
        (0..<Self.samples).map { i in
            let a = Double(i) / Double(Self.samples) * 2 * .pi
            return Stamp(id: i, offset: CGSize(width: cos(a) * edge, height: sin(a) * edge))
        }
    }

    var body: some View {
        ZStack {
            ForEach(stamps) { stamp in
                glyphs(.white).offset(stamp.offset)
            }
            glyphs(Tokens.ink)
        }
        // `filter: drop-shadow(6px 6px 0 var(--shadow-ink))` — a filter follows
        // the rendered alpha, which is what `hardShadow` does, so the glyphs
        // cast rather than a box around them.
        .hardShadow(CGSize(width: 6, height: 6))
    }

    private func glyphs(_ color: Color) -> some View {
        Text(text)
            .font(Fonts.display(size, weight: .bold))
            .foregroundStyle(color)
            .fixedSize()
    }
}

// MARK: - The pause overlay

/// Frosted glass over the frozen race with a floating card of choices.
///
/// **The freeze itself is not here.** `ttp_ui_freeze_transition` is the ONE
/// writer of `ttp_pause`/`ttp_resume`, the display hold and the music pause, and
/// the coordinator performs its answer (`syncSessionFrozen`). This view is the
/// two buttons and the glass.
struct PauseOverlay: View {

    /// Resume. The caller owns the gate (`ttp_ui_can_resume`) and the three
    /// writes that follow it.
    let onContinue: () -> Void
    /// Quit to the lobby. A mid-race quit, and it cancels a cup too — which is
    /// `ttp_race_return_json`'s answer to make, not this view's.
    let onNewGame: () -> Void

    private enum Control: Hashable { case resume, quit }
    @FocusState private var focus: Control?

    var body: some View {
        ZStack {
            // `backdrop-filter: blur(10px)` under `rgba(255, 246, 235, 0.72)`:
            // the paper token at its own alpha, so the pause glass and the
            // results glass are the same surface at two strengths.
            //
            // Only the GLASS reaches past the safe area. The card stays inside
            // it, because a TV's overscan is real and a button under the bezel
            // is a button nobody can press.
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            Rectangle().fill(Tokens.paper.opacity(0.72)).ignoresSafeArea()

            StickerCard(tint: Tokens.surface, padding: 44) {
                VStack(spacing: 32) {
                    Text(Copy.paused)
                        .font(Fonts.display(54, weight: .bold))
                        .foregroundStyle(Tokens.ink)
                    HStack(spacing: 22) {
                        StickerButton(Copy.continueLabel, tint: Tokens.brand,
                                      size: 30, action: onContinue)
                            .focused($focus, equals: .resume)
                        // `.btn--ghost`: a WHITE face with ink type, which is
                        // the web's own quiet secondary. It used to be drawn as
                        // an ink-FILLED primary on the grounds that the kit's
                        // button always draws white type — that was a gap in the
                        // component, not a hierarchy, and it put the darkest
                        // value in the palette next to the green Continue, which
                        // reads as the louder of the two.
                        StickerButton(Copy.newGameLabel, size: 30, ghost: true,
                                      action: onNewGame)
                            .focused($focus, equals: .quit)
                    }
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

// MARK: - The now-playing credit

/// The bottom-left credit chip.
///
/// **THIS IS A LICENSING OBLIGATION, NOT DECORATION.** The race catalogue is
/// Kevin MacLeod's under CC-BY, and a shell that plays it owes a visible credit.
/// Do not hide it to clean up the frame, and do not make it conditional on
/// anything but the music actually playing (`show-music-credit` clears
/// `GameState.musicCredit`, which is the only thing that takes it away).
struct MusicCreditChip: View {

    let credit: GameState.MusicCredit

    var body: some View {
        // "♪" and two spaces — `.music-credit::before`.
        Text("\u{266A}  " + Copy.musicCredit(title: credit.title, artist: credit.artist))
            .font(Fonts.body(22, weight: .bold))
            .foregroundStyle(.white.opacity(0.92))
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.vertical, 10)
            .padding(.horizontal, 22)
            // A dark translucent pill so it reads over the bright 3D scene
            // without competing with the HUD. `--ink` at the CSS's own 0.55,
            // never `#000` (`theme.css`'s standing rule).
            .background(Capsule().fill(Tokens.ink.opacity(0.55)))
            .opacity(0.9)
            // The web hangs the LICENSE and the source link off a tooltip. A TV
            // has neither a pointer nor a browser to hand a URL to, so the long
            // form rides the accessibility label — which is somewhere reachable,
            // and is what the ledger asks for. The chip itself stays
            // non-focusable: it is not an action, and a focusable chip on the
            // race screen would compete with the pause overlay for the remote.
            .accessibilityLabel(Copy.musicCreditFull(title: credit.title,
                                                     artist: credit.artist,
                                                     license: credit.license))
            .allowsHitTesting(false)
    }
}
