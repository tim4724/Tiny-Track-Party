import SwiftUI

/// The "Sticker Bash" component kit — `theme.css`'s `.card .btn .chip .pill`,
/// the `.wordmark` badge and the `.scene` paper stage, as SwiftUI.
///
/// The language, from `theme.css`'s own header: die-cut STICKERS on the TV
/// glass. Flat saturated colour on warm paper, thick warm-ink outlines (`--ink`
/// #2A2735, **never** `#000`), hard UN-BLURRED offset shadows, everything
/// slightly rotated as if slapped on by hand. Chrome is red/green/blue/purple
/// only; amber, pink, orange and cyan are liveries (`Tokens.car`) and never
/// chrome. Celebration is RED.
///
/// Build new screens out of these. Page code owns LAYOUT; this file owns
/// colour, type, surface and shadow — the same split the CSS keeps, and the
/// reason the web's screens stayed consistent for free.
enum Sticker {

    /// Border weight. `theme.css` says 3px; one point heavier here because the
    /// same picture is read from across a room rather than at arm's length, and
    /// because a 3-point line is the first thing a TV's edge sharpening eats.
    /// The extension default below mirrors this.
    static var border: CGFloat { 4 }
    /// Thinner rule, for the small tokens the CSS draws at 2-2.5px (livery dots,
    /// mini-map frames, the difficulty pips).
    static var hairlineBorder: CGFloat { 2.5 }

    static var radiusSmall: CGFloat { Tokens.radius("r-sm") }
    static var radius: CGFloat { Tokens.radius("r") }
    static var radiusLarge: CGFloat { Tokens.radius("r-lg") }

    /// `--shadow-pop` — chips and small stickers.
    static var popShadow: CGSize { Tokens.shadow("shadow-pop").offset }
    /// `--shadow-card` — big sticker cards.
    static var cardShadow: CGSize { Tokens.shadow("shadow-card").offset }

    /// Ledge geometry, and the one invariant behind it. `--btn-drop` is how far
    /// the ink ledge sits below a button at rest; `--btn-sink` is how far the
    /// face travels when pressed; the ledge you can still see while pressed is
    /// the DIFFERENCE. That is why `--btn-sink` must stay under `--btn-drop`
    /// (travel equal to the drop would punch the button through its own ledge
    /// and flatten it) and why `Tokens` asserts it at load.
    static var buttonDrop: CGFloat { Tokens.length("btn-drop") }
    static var buttonSink: CGFloat { Tokens.length("btn-sink") }

    /// How the two web pointer states map onto a TV.
    ///
    /// tvOS has no pointer, so `:hover` has no analogue at all and `:active` is
    /// not a state the user can dwell in. What replaces both is the FOCUS
    /// ENGINE: exactly one control on screen is focused, and the remote's
    /// click is a momentary press on that one.
    ///
    ///   `:hover`  (`filter: brightness(1.04)`, `.ticket:hover`'s deeper shadow)
    ///             → FOCUSED: brighten, lift by `focusScale`, deepen the shadow.
    ///   `:active` (`translateY(--btn-sink)`, ledge shrinks to drop - sink)
    ///             → PRESSED: unchanged, the ledge geometry ports as-is.
    ///
    /// The lift is the piece with no CSS ancestor. It exists because focus on a
    /// TV has to be legible from the sofa, where a 4% brightness change is not.
    static var focusScale: CGFloat { 1.06 }
    static var focusBrightness: Double { 0.04 }
    static var focusShadow: CGSize { CGSize(width: 10, height: 10) }
}

// MARK: - Modifiers

extension View {

    /// The thick warm-ink outline every sticker carries.
    ///
    /// `strokeBorder` rather than `stroke`: it insets by half the line width, so
    /// the outline sits INSIDE the shape's bounds. That is CSS's
    /// `box-sizing: border-box`, which the whole kit is authored against — a
    /// centred stroke would grow every card by the border weight and pull the
    /// chip rows out of alignment with the geometry C++ hands back.
    ///
    /// - Parameters:
    ///   - width: default 4 (`Sticker.border`).
    ///   - radius: the corner radius the outline follows. It has to be told,
    ///     because an outline cannot infer the shape underneath it.
    func stickerOutline(_ width: CGFloat = Sticker.border,
                        radius: CGFloat = Sticker.radius,
                        color: Color = Tokens.ink) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(color, lineWidth: width)
        )
    }

    /// The die-cut drop: a hard offset shadow with ZERO blur.
    ///
    /// The blur is what makes the difference. A blurred shadow reads as a card
    /// floating above a surface; an unblurred one reads as a sticker cut out and
    /// stuck down, which is the whole language. `theme.css` states the rule as
    /// "offset is about 2x the border width, alpha always 0.18, so every sticker
    /// reads as stamped by the same machine".
    ///
    /// **Apply this to the SHAPE, not to a composed view.** CSS `box-shadow`
    /// follows the box; SwiftUI's `.shadow` follows the rendered ALPHA, so
    /// shadowing a card that already contains its label embosses the text too.
    /// Every component below therefore shadows its background shape.
    /// `Wordmark` is the deliberate exception: the CSS there is `filter:
    /// drop-shadow`, which follows the alpha as well, so the glyphs SHOULD cast.
    func hardShadow(_ offset: CGSize = CGSize(width: 6, height: 6),
                    color: Color = Tokens.shadowInk) -> some View {
        shadow(color: color, radius: 0, x: offset.width, y: offset.height)
    }
}

// MARK: - Card

/// `.card` — the sticker panel everything important sits on.
///
/// `theme.css`'s `.card` carries no padding on purpose (the page owns layout),
/// so the default here is this shell's rather than the design system's.
struct StickerCard<Content: View>: View {
    private let tint: Color
    private let rotation: Double
    private let padding: CGFloat
    private let content: Content

    init(tint: Color = Tokens.surface,
         rotation: Double = 0,
         padding: CGFloat = 28,
         @ViewBuilder content: () -> Content) {
        self.tint = tint
        self.rotation = rotation
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Sticker.radiusLarge, style: .continuous)
        return content
            .padding(padding)
            .background(shape.fill(tint).hardShadow(Sticker.cardShadow))
            .stickerOutline(Sticker.border, radius: Sticker.radiusLarge)
            // Slapped down by hand: the tilt is applied LAST so the shadow tilts
            // with the card rather than staying square to the screen.
            .rotationEffect(.degrees(rotation))
    }
}

// MARK: - Button

/// `.btn` — the chunky sticker push-button, driven by the focus engine.
struct StickerButton: View {
    private let title: String
    private let tint: Color
    private let size: CGFloat
    private let ghost: Bool
    private let action: () -> Void

    /// - Parameter size: default 34, which is what the welcome board's CTA
    ///   already resolves to on a 1920-wide web display
    ///   (`clamp(22px, 2.6vw, 34px)`). tvOS is always 1920x1080 POINTS whatever
    ///   the box outputs (ledger 2.6), so that number transfers unchanged.
    /// - Parameter ghost: `.btn--ghost` — the QUIET secondary action. A WHITE
    ///   face with ink type, keeping the same ledge DEPTH as a primary so the
    ///   two sit level; only the ledge's colour goes translucent (`theme.css`
    ///   uses `rgba(42, 39, 53, 0.35)` there rather than the solid token).
    ///
    ///   It exists because the substitute was visibly not it. The pause card's
    ///   second button was drawn as an INK-FILLED primary — the darkest value in
    ///   the palette, beside a green Continue — so the quiet option read as the
    ///   loud one, and a viewer comparing the two boards sees a black slab where
    ///   the web has a white sticker. A quiet action drawn in the heaviest ink
    ///   available is not a quieter button, it is a different button.
    init(_ title: String,
         tint: Color = Tokens.brand,
         size: CGFloat = 34,
         ghost: Bool = false,
         action: @escaping () -> Void) {
        self.title = title
        self.tint = ghost ? Tokens.surface : tint
        self.size = size
        self.ghost = ghost
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Fonts.display(size, weight: .bold))
                .foregroundStyle(ghost ? Tokens.ink : .white)
        }
        .buttonStyle(StickerButtonStyle(tint: tint, size: size, ghost: ghost))
        // THE SYSTEM FOCUS EFFECT IS OFF, and this is not a taste call.
        //
        // tvOS draws its own focus treatment UNDER a Button — a large rounded
        // slab sized to the button's layout frame, not to its drawn face. This
        // style already says everything about focus that the design system wants
        // said (the brightness lift, the scale, the hard shadow), so the system
        // slab is redundant AND it was the visible defect: a dark rectangle
        // spreading across the lower third of the lobby and the results board,
        // behind the button, on every screenshot this shell has ever taken.
        //
        // `fixedSize` is the other half. A Button on tvOS takes the width it is
        // offered, so inside a VStack the slab spanned the whole board even
        // though the face is only as wide as its label.
        .focusEffectDisabled()
        .fixedSize()
    }
}

private struct StickerButtonStyle: ButtonStyle {
    let tint: Color
    let size: CGFloat
    let ghost: Bool

    func makeBody(configuration: Configuration) -> some View {
        // The focus flag has to be read one level down: @Environment is only
        // resolved inside a View's body, and makeBody(configuration:) is not one.
        Face(configuration: configuration, tint: tint, size: size, ghost: ghost)
    }

    private struct Face: View {
        let configuration: StickerButtonStyle.Configuration
        let tint: Color
        let size: CGFloat
        let ghost: Bool

        @Environment(\.isFocused) private var isFocused

        var body: some View {
            let pressed = configuration.isPressed
            let drop = Sticker.buttonDrop
            let shape = RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)

            // `.btn`'s padding is 0.8em 1.2em — em-relative, so it scales with
            // whatever size the caller picked.
            return ZStack(alignment: .top) {
                // The ledge. It does NOT move: the face travels down onto it by
                // --btn-sink, leaving (drop - sink) of ledge visible, which is
                // exactly what the CSS's shrinking box-shadow draws.
                //
                // A GHOST's ledge is the ink at 35%, not the solid token: a
                // white face over a full-strength ledge reads as a white card
                // sitting on a black bar. Same DEPTH, lighter ink — `theme.css`
                // spells both halves of that in `.btn--ghost`.
                shape.fill(ghost ? Tokens.ink.opacity(0.35) : Tokens.btnLedge)
                    .offset(y: drop)

                configuration.label
                    .padding(.vertical, size * 0.8)
                    .padding(.horizontal, size * 1.2)
                    .background(
                        shape.fill(tint)
                            .hardShadow(isFocused ? Sticker.focusShadow : .zero)
                    )
                    .stickerOutline(Sticker.border, radius: Sticker.radius)
                    .offset(y: pressed ? Sticker.buttonSink : 0)
            }
            // Reserve the ledge, which `offset` does not take part in layout for.
            .padding(.bottom, drop)
            .brightness(isFocused ? Sticker.focusBrightness : 0)
            .scaleEffect(isFocused ? Sticker.focusScale : 1)
            // 0.06s is the kit's own transition; focus gets a touch longer so the
            // lift reads as movement rather than a jump.
            .animation(.easeOut(duration: 0.06), value: pressed)
            .animation(.easeOut(duration: 0.12), value: isFocused)
        }
    }
}

// MARK: - Pill

/// `.pill` — an ink label sticker: white uppercase caps on a solid pill.
///
/// The uppercasing is `text-transform: uppercase` in the CSS, i.e. a look
/// decision applied at render, not something baked into the data. It is done
/// here for the same reason: `Copy.races` answers "1 race" and both screens
/// should be able to spell it either way.
struct StickerPill: View {
    private let text: String
    private let tint: Color
    private let size: CGFloat

    /// - Parameter size: default 18. The web pill is 0.7-0.78rem (~12px) — the
    ///   one place a straight transfer would be genuinely unreadable across a
    ///   room, so this is the kit's largest deliberate departure from the CSS.
    init(_ text: String, tint: Color = Tokens.ink, size: CGFloat = 18) {
        self.text = text
        self.tint = tint
        self.size = size
    }

    var body: some View {
        Text(text.uppercased())
            .font(Fonts.display(size, weight: .semibold))
            .tracking(size * 0.12)          // letter-spacing: 0.12em
            .foregroundStyle(.white)
            .padding(.vertical, size * 0.35)
            .padding(.horizontal, size * 0.95)
            .background(Capsule().fill(tint))
    }
}

// MARK: - Wordmark

/// The ONE die-cut badge: "TINY TRACK" over "PARTY!". Never a row of pills,
/// never plain text.
///
/// The white edge is `-webkit-text-stroke: 7px #fff` with `paint-order: stroke
/// fill` in the CSS, and there is no text stroke in SwiftUI at all. It is drawn
/// here as offset white copies behind the fill, which is the only primitive
/// available. That is more layers than it sounds like, but this is static
/// chrome on two boards and never on the race path — and the CSS itself already
/// declares a graceful degradation ("without paint-order support it degrades to
/// plain ink text — acceptable"), so `dieCut: false` is a supported look, not a
/// fallback. The ticket masthead uses it: a white edge on a white card is
/// invisible, so `.ticket__wordmark` zeroes the stroke.
struct Wordmark: View {
    private let size: CGFloat
    private let dieCut: Bool

    /// - Parameter size: default 130, the poster scale a 1920-wide web display
    ///   clamps `.welcome__wordmark` to. The lobby ticket's masthead is 38.
    init(size: CGFloat = 130, dieCut: Bool = true) {
        self.size = size
        self.dieCut = dieCut
    }

    /// How far the white cut reaches OUTSIDE the glyphs.
    ///
    /// The CSS pins the stroke at 7px against a font-size that clamps between 56
    /// and 130, so on the web the edge is proportionally heavier on a small
    /// window. A TV has exactly one size, so the faithful reading at poster
    /// scale is 7/130 of the type size — HALVED, because a text stroke is
    /// centred on the outline and only half of it shows, while these stamps
    /// dilate the glyph by their full offset. Same correction, same reason, as
    /// `CountdownView.DieCutText`; it is only obvious there because that face is
    /// 281 points and this one is at most 130.
    private var edge: CGFloat { size * 0.055 / 2 }

    /// Enough offsets that a 7pt edge round a chunky display face reads as one
    /// continuous cut rather than a ring of blobs.
    private static let edgeSamples = 16

    private struct EdgeStamp: Identifiable {
        let id: Int
        let offset: CGSize
    }

    /// The ring the white copies are stamped around, precomputed so the
    /// ViewBuilder below stays a plain list of views.
    private var edgeStamps: [EdgeStamp] {
        (0..<Self.edgeSamples).map { i in
            let a = Double(i) / Double(Self.edgeSamples) * 2 * .pi
            return EdgeStamp(id: i, offset: CGSize(width: cos(a) * edge, height: sin(a) * edge))
        }
    }

    var body: some View {
        ZStack {
            if dieCut {
                ForEach(edgeStamps) { stamp in
                    lockup(top: .white, bottom: .white).offset(stamp.offset)
                }
            }
            lockup(top: Tokens.ink, bottom: Tokens.red)
        }
        // Shadow BEFORE the rotation, so it tilts with the badge. CSS applies
        // `filter` in the element's own space and `transform` after it, so the
        // web's drop-shadow is rotated too.
        .hardShadow(CGSize(width: 3, height: 3))
        .rotationEffect(.degrees(-2))
        .accessibilityElement()
        .accessibilityLabel("\(Copy.wordmarkLine1) \(Copy.wordmarkLine2)")
    }

    private func lockup(top: Color, bottom: Color) -> some View {
        VStack(spacing: 0) {
            line(Copy.wordmarkLine1, size, top)
            // `.wordmark .l2 { font-size: 1.24em }` — PARTY! is the louder half.
            line(Copy.wordmarkLine2, size * 1.24, bottom)
        }
    }

    /// `line-height: 0.98` on a display face, which SwiftUI has no direct knob
    /// for: a Text given a height shorter than its natural line box still draws
    /// the glyphs in full and simply overhangs, which is exactly what a
    /// sub-1.0 line-height does in CSS.
    private func line(_ text: String, _ pt: CGFloat, _ color: Color) -> some View {
        // `.tracking` before `.foregroundStyle`: both are Text-returning, but
        // only the Text overload of foregroundStyle keeps the chain in Text —
        // ordering it last removes any chance of resolving to the View one and
        // losing `tracking`.
        Text(text)
            .font(Fonts.display(pt, weight: .bold))
            .tracking(pt * 0.01)               // letter-spacing: 0.01em
            .foregroundStyle(color)
            .fixedSize(horizontal: true, vertical: false)
            .frame(height: pt * 0.98)
    }
}

// MARK: - Paper stage

/// The full-screen warm-paper backdrop that boards sit on: `theme.css`'s
/// `.scene` — sky glow, two rolling hills, three sticker clouds, a flat grass
/// band. Decorative only; it never takes focus and never eats a remote press.
///
/// **WHERE THIS MAY GO.** Paper backgrounds are for FULL-SCREEN BOARDS only —
/// the welcome title board, and the lobby before a track is picked. Chrome that
/// floats over the live 3D view floats BARE: no paper, no panel behind it. And
/// nothing inside the 3D scene is ever outlined or toon-shaded, which is the
/// same rule seen from the other side. Putting a `PaperStage` behind the race
/// HUD would break both at once.
///
/// (There is no sun. It was yellow, and yellow is vetoed in chrome.)
struct PaperStage<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ZStack {
            GeometryReader { geo in backdrop(geo.size) }
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            content
        }
        // The ShapeStyle overload, which ignores every safe-area edge by
        // default — the paper has to reach the bezel.
        .background(Tokens.paper)
    }

    private func backdrop(_ s: CGSize) -> some View {
        let w = s.width, h = s.height
        return ZStack(alignment: .topLeading) {
            sky(w, h)

            // Rolling hills peeking over the grass band. These two greens are
            // authored inline in `theme.css`'s `.scene__sky::before/::after`
            // rather than as `:root` tokens, and the bake only carries `:root` —
            // so they are hardcoded here for the same reason they are hardcoded
            // there: they are stage scenery, not part of the design system.
            hill(color: Color(red: 0xd3 / 255.0, green: 0xed / 255.0, blue: 0xbb / 255.0),
                 w: 0.74 * w, h: 0.30 * h, x: -0.16 * w, y: h - 0.11 * h - 0.30 * h)
            hill(color: Color(red: 0xe0 / 255.0, green: 0xf3 / 255.0, blue: 0xcd / 255.0),
                 w: 0.82 * w, h: 0.36 * h, x: w + 0.20 * w - 0.82 * w, y: h - 0.09 * h - 0.36 * h)

            // Clouds, at the sizes and positions the CSS gives in px. Those px
            // are authored against a ~1920-wide display and tvOS is always
            // 1920x1080 POINTS, so they transfer 1:1 (ledger 2.6). Positioned
            // clear of the lobby's rails: the ticket on the left, the cup slot
            // on the right, the tagline down the middle.
            cloud(w: 150, h: 42, x: 0.34 * w, y: 0.09 * h, rotation: -2,
                  humps: [Hump(size: 62, x: 24, y: -26), Hump(size: 46, x: 82, y: -16)])
            cloud(w: 104, h: 30, x: w - 0.23 * w - 104, y: 0.20 * h, rotation: 2,
                  humps: [Hump(size: 44, x: 18, y: -18), Hump(size: 34, x: 54, y: -11)])
            cloud(w: 84, h: 26, x: w - 0.09 * w - 84, y: 0.36 * h, rotation: -2,
                  humps: [Hump(size: 36, x: 14, y: -15), Hump(size: 28, x: 44, y: -9)])

            // The grass band bleeds 2% past each edge so its rounded top never
            // shows a corner.
            GrassBand(width: 1.04 * w, height: 0.24 * h)
                .foregroundStyle(Tokens.grass)
                .offset(x: -0.02 * w, y: 0.76 * h)
        }
    }

    /// `radial-gradient(120% 90% at 50% -20%, #fffdf7 0%, transparent 55%)` — a
    /// soft warm glow high in the sky that gives the paper some air.
    ///
    /// `EllipticalGradient` rather than `RadialGradient` because the CSS shape
    /// is an ellipse (120% of the width by 90% of the height) and a circle on a
    /// 16:9 stage is visibly a different glow. The far stop is the SAME colour
    /// at zero opacity, never `.clear` — `.clear` is transparent BLACK, and
    /// interpolating towards it would drag a grey bruise through the fade.
    private func sky(_ w: CGFloat, _ h: CGFloat) -> some View {
        let glow = Color(red: 0xff / 255.0, green: 0xfd / 255.0, blue: 0xf7 / 255.0)
        return EllipticalGradient(
            gradient: Gradient(stops: [
                .init(color: glow, location: 0),
                .init(color: glow.opacity(0), location: 0.55),
            ]),
            center: .center,
            startRadiusFraction: 0,
            endRadiusFraction: 0.5)
            .frame(width: 2.4 * w, height: 1.8 * h)
            .position(x: 0.5 * w, y: -0.2 * h)
    }

    private func hill(color: Color, w: CGFloat, h: CGFloat, x: CGFloat, y: CGFloat) -> some View {
        Ellipse().fill(color).frame(width: w, height: h).offset(x: x, y: y)
    }

    private struct Hump: Identifiable {
        let size: CGFloat
        let x: CGFloat
        let y: CGFloat
        var id: CGFloat { x }
    }

    /// A sticker cloud: a white outlined pill with outlined circle humps.
    ///
    /// The humps are masked to their top 60% (`clip-path: inset(0 0 40% 0)`) so
    /// their cut edge hides inside the pill's white body and the outline reads
    /// as ONE die-cut shape. They are drawn ON TOP of the pill for that to work,
    /// which is the CSS's own paint order (::before/::after over the parent).
    ///
    /// `#fff`, not `--surface`: the CSS scene rules write the literal, because
    /// a cloud is scenery rather than a sticker surface and should not follow
    /// `--surface` if that ever moves.
    private func cloud(w: CGFloat, h: CGFloat, x: CGFloat, y: CGFloat,
                       rotation: Double, humps: [Hump]) -> some View {
        Capsule()
            .fill(Color.white)
            .frame(width: w, height: h)
            .overlay(Capsule().strokeBorder(Tokens.ink, lineWidth: 3))
            // Stage scenery deliberately runs LIGHTER than chrome: alpha 0.10
            // against the kit's 0.18. It is backdrop, and a full-strength drop
            // would make the clouds compete with the cards in front of them.
            .hardShadow(CGSize(width: 4, height: 4), color: Tokens.ink.opacity(0.10))
            .overlay(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    ForEach(humps) { hump in
                        Circle()
                            .fill(Color.white)
                            .frame(width: hump.size, height: hump.size)
                            .overlay(Circle().strokeBorder(Tokens.ink, lineWidth: 3))
                            .mask(alignment: .top) { Rectangle().frame(height: hump.size * 0.6) }
                            .offset(x: hump.x, y: hump.y)
                    }
                }
            }
            .rotationEffect(.degrees(rotation))
            .offset(x: x, y: y)
    }
}

/// `border-radius: 50% 50% 0 0 / 22% 22% 0 0` — a flat band with a gently
/// rounded top and square bottom corners.
///
/// Both top corners have rx = 50% of the width, so the two quarter-ellipses meet
/// in the middle and the entire top edge is ONE half-ellipse of height 22%.
/// Drawn as an ellipse and a rectangle that OVERLAP by that height rather than
/// as one Bezier-approximated path: same fill, no seam, no curve to get wrong.
///
/// No outline. Outlines belong to the stickers sitting on the stage, not to the
/// stage.
private struct GrassBand: View {
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        let ry = height * 0.22
        return ZStack(alignment: .top) {
            Ellipse().frame(width: width, height: ry * 2)
            Rectangle().frame(width: width, height: max(0, height - ry)).offset(y: ry)
        }
        .frame(width: width, height: height, alignment: .top)
    }
}
