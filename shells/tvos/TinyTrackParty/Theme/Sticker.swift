import SwiftUI

/// The "Toy Box" component kit — `theme.css`'s `.card .btn .pill`, the
/// `.wordmark` lockup and the `.scene` paper stage, as SwiftUI.
///
/// The language is `theme.css`'s SIX ROLES, each meaning the same thing on the
/// phone, the web display and here, so what a thing looks like says what it
/// does: PAPER (white cards you read, `StickerCard`), FROST (every full-screen
/// layer, `Frost`), ACTION (the one solid colour button per screen), CHOICE
/// (white with a faint edge, everything else you press — the ghost
/// `StickerButton`), LABEL (a tinted pill, `StickerPill`) and GLASS (dark
/// readouts over the live 3D view, `Tokens.glass`). Everything is FLAT: no ink
/// outlines, no offset shadows, no ledges, and no tilt beyond the few the web's
/// own lockups carry (the wordmark, the champions label). Chrome is
/// red/green/blue/purple only; amber, pink, orange and cyan are liveries
/// (`Tokens.car`) and never chrome. Celebration is RED.
///
/// Build new screens out of these. Page code owns LAYOUT; this file owns
/// colour, type and surface — the same split the CSS keeps.
enum Sticker {

    static var radiusSmall: CGFloat { Tokens.radius("r-sm") }
    static var radius: CGFloat { Tokens.radius("r") }
    static var radiusLarge: CGFloat { Tokens.radius("r-lg") }

    /// A CHOICE's faint edge, `box-shadow: inset 0 0 0 2px var(--edge)`.
    static var edge: CGFloat { 2 }
    /// The picked choice's ring, `inset 0 0 0 3px`, and the focus ring's weight
    /// (`--focus-ring: 3px solid var(--blue)`).
    static var ring: CGFloat { 3 }

    /// The darkening ink a LABEL's text and a pick's ring are mixed toward
    /// (`color-mix(in srgb, var(--c) 78%, #1B1830)`). A literal in the CSS, not a
    /// `:root` token, so it is a literal here.
    static let labelInk = Color(red: 0x1B / 255.0, green: 0x18 / 255.0, blue: 0x30 / 255.0)

    /// How the web's pointer states map onto a TV.
    ///
    /// tvOS has no pointer, so `:hover` has no analogue and `:active` is not a
    /// state the user can dwell in. What replaces both is the FOCUS ENGINE:
    /// exactly one control on screen is focused, and the remote's click is a
    /// momentary press on that one. Focus is `:focus-visible`'s blue ring (an
    /// action) or the picked wash and ring (a choice), plus a LIFT that has no
    /// CSS ancestor: focus on a TV has to be legible from the sofa.
    static var focusScale: CGFloat { 1.06 }
    /// `transform: scale(0.96)` while pressed.
    static var pressScale: CGFloat { 0.96 }
}

// MARK: - Colour mixing

extension Color {
    /// `color-mix(in srgb, self <share>, other)`: a straight lerp on the ENCODED
    /// components, which is what `in srgb` means and what makes this reproduce
    /// the browser's answer (the same mix in linear light comes out darker).
    func mixed(_ share: Double, with other: Color) -> Color {
        var a = (r: CGFloat(0), g: CGFloat(0), b: CGFloat(0), al: CGFloat(0))
        var b = a
        UIColor(self).getRed(&a.r, green: &a.g, blue: &a.b, alpha: &a.al)
        UIColor(other).getRed(&b.r, green: &b.g, blue: &b.b, alpha: &b.al)
        let s = CGFloat(share)
        return Color(red: Double(a.r * s + b.r * (1 - s)),
                     green: Double(a.g * s + b.g * (1 - s)),
                     blue: Double(a.b * s + b.b * (1 - s)))
    }
}

// MARK: - Choice edge

extension Sticker {
    /// A CHOICE's faint edge, or the picked one's ring — the TV's pick is blue,
    /// mixed toward the label ink as the phone's tile ring is. Drawn INSIDE the
    /// shape's bounds: the CSS spells both as an inset box-shadow, which takes no
    /// layout, and `strokeBorder` is the same — it insets by half the line.
    static func choiceEdge<S: InsettableShape>(_ shape: S, picked: Bool) -> some View {
        shape.strokeBorder(picked ? Tokens.blue.mixed(0.82, with: labelInk) : Tokens.edge,
                           lineWidth: picked ? ring : edge)
    }
}

// MARK: - Card

/// `.card` — PAPER: the white panel everything you read sits on. Flat: no
/// outline, no shadow.
///
/// `theme.css`'s `.card` carries no padding on purpose (the page owns layout),
/// so the default here is this shell's rather than the design system's.
struct StickerCard<Content: View>: View {
    private let padding: CGFloat
    private let content: Content

    init(padding: CGFloat = 28, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .background(RoundedRectangle(cornerRadius: Sticker.radiusLarge, style: .continuous)
                .fill(Tokens.surface))
    }
}

// MARK: - Frost

/// FROST: every full-screen layer (pause, the display's link, the results
/// boards). The screen behind blurred and lightened, the content straight on
/// it — never a card on a scrim.
///
/// `background: var(--frost); backdrop-filter: blur(var(--frost-r))`. The blur
/// is the system material, forced LIGHT so it stays the web's pale wash and
/// never tvOS's default dark one; the frost token on top does the lightening.
/// The GLASS reaches the bezel; whatever stands on it stays inside the safe area.
struct Frost: View {
    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
            Rectangle().fill(Tokens.frost)
        }
        .environment(\.colorScheme, .light)
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

// MARK: - Button

/// `.btn` — an ACTION (a solid colour face, white type) or, as `ghost`, a
/// CHOICE (`.btn--ghost`: white, the faint edge, ink type). Driven by the focus
/// engine.
struct StickerButton: View {
    private let title: String
    private let style: StickerButtonStyle
    private let action: () -> Void

    /// - Parameter size: default 34, which is what the welcome board's CTA
    ///   resolves to on a 1920-wide web display (`clamp(22px, 2.6vw, 34px)`).
    ///   tvOS is always 1920x1080 POINTS whatever the box outputs (ledger 2.6),
    ///   so that number transfers unchanged.
    /// - Parameter ghost: the QUIET option beside an action. It exists because
    ///   the substitute was visibly not it: the pause board's second button was
    ///   once drawn as an INK-FILLED primary beside a green Continue, and a quiet
    ///   action drawn in the heaviest ink available reads as the louder one.
    init(_ title: String,
         tint: Color = Tokens.brand,
         size: CGFloat = 34,
         ghost: Bool = false,
         minWidth: CGFloat = 0,
         action: @escaping () -> Void) {
        self.title = title
        self.style = StickerButtonStyle(tint: tint, size: size, ghost: ghost, minWidth: minWidth)
        self.action = action
    }

    var body: some View {
        Button(action: action) { Text(title) }
            .buttonStyle(style)
            // THE SYSTEM FOCUS EFFECT IS OFF, and this is not a taste call.
            //
            // tvOS draws its own focus treatment UNDER a Button — a large rounded
            // slab sized to the button's layout frame, not to its drawn face. The
            // style already says everything about focus the design system wants
            // said, so the system slab is redundant AND it was the visible
            // defect: a dark rectangle spreading behind the button on every
            // screenshot this shell took.
            //
            // `fixedSize` is the other half. A Button on tvOS takes the width it
            // is offered, so inside a VStack the slab spanned the whole board.
            .focusEffectDisabled()
            .fixedSize()
    }
}

/// The face `StickerButton` draws, and the one a `NavigationLink` wears too:
/// tvOS restores focus onto a link when its page pops, which an
/// action-plus-state button does not get for free, so the info board's
/// Licenses link takes this style rather than forking the look.
struct StickerButtonStyle: ButtonStyle {
    var tint: Color = Tokens.brand
    var size: CGFloat = 34
    var ghost: Bool = false
    /// `.pause-card__btns .btn { min-width: 9em }` — a pair is one size.
    var minWidth: CGFloat = 0

    func makeBody(configuration: Configuration) -> some View {
        // The focus flag has to be read one level down: @Environment is only
        // resolved inside a View's body, and makeBody(configuration:) is not one.
        Face(configuration: configuration, style: self)
    }

    private struct Face: View {
        let configuration: StickerButtonStyle.Configuration
        let style: StickerButtonStyle

        @Environment(\.isFocused) private var isFocused

        var body: some View {
            let pressed = configuration.isPressed
            let shape = RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)
            // `.btn`'s padding is 0.85em 1.25em — em-relative, so it scales with
            // whatever size the caller picked.
            return configuration.label
                .font(Fonts.display(style.size, weight: .semibold))
                .foregroundStyle(style.ghost ? Tokens.ink : .white)
                .padding(.vertical, style.size * 0.85)
                .padding(.horizontal, style.size * 1.25)
                .frame(minWidth: style.minWidth)
                .background(shape.fill(face(pressed: pressed)))
                .overlay {
                    if style.ghost {
                        // A choice: the faint edge, turning into the pick's ring
                        // while focused — washed AND ringed, as a picked tile is.
                        Sticker.choiceEdge(shape, picked: isFocused)
                    } else if isFocused {
                        // An action: `.btn:focus-visible`'s blue ring, 4 out.
                        RoundedRectangle(cornerRadius: Sticker.radius + 7, style: .continuous)
                            .strokeBorder(Tokens.blue, lineWidth: Sticker.ring)
                            .padding(-7)
                    }
                }
                // A press DARKENS an action (`filter: brightness(0.9)`, which
                // multiplies where SwiftUI's adds) and washes a choice instead.
                .brightness(pressed && !style.ghost ? -0.08 : 0)
                .scaleEffect(pressed ? Sticker.pressScale : isFocused ? Sticker.focusScale : 1)
                // Down instantly, back up over `--press-up`; focus gets a touch
                // longer so the lift reads as movement rather than a jump.
                .animation(pressed ? nil : .easeOut(duration: 0.05), value: pressed)
                .animation(.easeOut(duration: 0.12), value: isFocused)
        }

        private func face(pressed: Bool) -> Color {
            guard style.ghost else { return style.tint }
            return pressed ? Tokens.press : isFocused ? Tokens.pick : Tokens.surface
        }
    }
}

// MARK: - Pill

/// `.pill` — a LABEL: uppercase caps in a colour on a pale tint of it. Never a
/// solid fill, so it never reads as something to press.
///
/// The uppercasing is `text-transform: uppercase` in the CSS, i.e. a look
/// decision applied at render, not something baked into the data.
struct StickerPill: View {
    private let text: String
    private let tint: Color
    private let size: CGFloat

    /// - Parameter tint: `--c`, `--ink-2` by default as in the CSS.
    /// - Parameter size: default 18. The web pill is 0.7rem (~11px) — the one
    ///   place a straight transfer would be unreadable across a room, so this is
    ///   the kit's largest deliberate departure from the CSS.
    init(_ text: String, tint: Color = Tokens.ink2, size: CGFloat = 18) {
        self.text = text
        self.tint = tint
        self.size = size
    }

    var body: some View {
        Text(text.uppercased())
            .font(Fonts.display(size, weight: .bold))
            .tracking(size * 0.1)          // letter-spacing: 0.1em
            .foregroundStyle(tint.mixed(0.78, with: Sticker.labelInk))
            .padding(.top, size * 0.32)
            .padding(.bottom, size * 0.38)
            .padding(.horizontal, size * 0.95)
            .background(Capsule().fill(tint.mixed(0.20, with: .white)))
    }
}

// MARK: - Wordmark

/// The ONE lockup: "TINY TRACK" in ink over a red "PARTY!" tipped against it.
/// Never a row of pills, never plain text. Flat, like everything else: the
/// sticker look's white die-cut edge is gone from the web's `.wordmark`, so it
/// is gone here.
struct Wordmark: View {
    private let size: CGFloat

    /// - Parameter size: default 130, the poster scale a 1920-wide web display
    ///   clamps `.welcome__wordmark` to. The lobby ticket's masthead is 38.
    init(size: CGFloat = 130) {
        self.size = size
    }

    var body: some View {
        VStack(spacing: 0) {
            line(Copy.wordmarkLine1, size, Tokens.ink)
            // `.wordmark .l2 { font-size: 1.24em; rotate: -3deg }` — PARTY! is
            // the louder half, and the only half that leans.
            line(Copy.wordmarkLine2, size * 1.24, Tokens.red)
                .rotationEffect(.degrees(-3))
        }
        .accessibilityElement()
        .accessibilityLabel("\(Copy.wordmarkLine1) \(Copy.wordmarkLine2)")
    }

    /// `line-height: 0.98` on a display face, which SwiftUI has no direct knob
    /// for: a Text given a height shorter than its natural line box still draws
    /// the glyphs in full and simply overhangs, which is exactly what a
    /// sub-1.0 line-height does in CSS.
    private func line(_ text: String, _ pt: CGFloat, _ color: Color) -> some View {
        Text(text)
            .font(Fonts.display(pt, weight: .bold))
            .tracking(pt * 0.01)               // letter-spacing: 0.01em
            .foregroundStyle(color)
            .fixedSize(horizontal: true, vertical: false)
            .frame(height: pt * 0.98)
    }
}

// MARK: - Paper stage

/// The full-screen backdrop that boards sit on: `theme.css`'s `.scene` — a pale
/// sky, two rolling hills, three soft clouds, a flat grass band. Decorative
/// only; it never takes focus and never eats a remote press.
///
/// **WHERE THIS MAY GO.** Paper backgrounds are for FULL-SCREEN BOARDS only —
/// the info and license boards, and the lobby before a track is picked. Chrome
/// that floats over the live 3D view floats BARE: no paper, no panel behind it.
/// And nothing inside the 3D scene is ever outlined or toon-shaded, which is the
/// same rule seen from the other side.
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

    // The sky's three stops and the two hill greens are authored inline in
    // `theme.css`'s `.scene__sky` rules rather than as `:root` tokens, and the
    // bake only carries `:root` — so they are literals here for the same reason
    // they are literals there: they are stage scenery, not the design system.
    private static func hex(_ rgb: UInt32) -> Color {
        Color(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255,
              blue: Double(rgb & 0xFF) / 255)
    }

    private func backdrop(_ s: CGSize) -> some View {
        let w = s.width, h = s.height
        return ZStack(alignment: .topLeading) {
            // `linear-gradient(180deg, #CFE7F7 0%, #EAF4FB 55%, #F3F8FC 100%)`.
            LinearGradient(stops: [.init(color: Self.hex(0xCFE7F7), location: 0),
                                   .init(color: Self.hex(0xEAF4FB), location: 0.55),
                                   .init(color: Self.hex(0xF3F8FC), location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .frame(width: w, height: h)

            // Rolling hills peeking over the grass band.
            hill(color: Self.hex(0xBFE3A6),
                 w: 0.74 * w, h: 0.30 * h, x: -0.16 * w, y: h - 0.11 * h - 0.30 * h)
            hill(color: Self.hex(0xA9D98C),
                 w: 0.82 * w, h: 0.36 * h, x: w + 0.20 * w - 0.82 * w, y: h - 0.09 * h - 0.36 * h)

            // Clouds, at the sizes and positions the CSS gives in px. Those px
            // are authored against a ~1920-wide display and tvOS is always
            // 1920x1080 POINTS, so they transfer 1:1 (ledger 2.6). Positioned
            // clear of the lobby's rails: the ticket on the left, the cup slot
            // on the right.
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

    private func hill(color: Color, w: CGFloat, h: CGFloat, x: CGFloat, y: CGFloat) -> some View {
        Ellipse().fill(color).frame(width: w, height: h).offset(x: x, y: y)
    }

    private struct Hump: Identifiable {
        let size: CGFloat
        let x: CGFloat
        let y: CGFloat
        var id: CGFloat { x }
    }

    /// A soft white pill with two circle humps, no outline: scenery, not chrome.
    ///
    /// The humps are masked to their top 60% (`clip-path: inset(0 0 40% 0)`) so
    /// their cut edge hides inside the pill's white body. `#fff`, not
    /// `--surface`: the CSS scene rules write the literal, because a cloud is
    /// scenery rather than a paper surface.
    private func cloud(w: CGFloat, h: CGFloat, x: CGFloat, y: CGFloat,
                       rotation: Double, humps: [Hump]) -> some View {
        Capsule()
            .fill(Color.white)
            .frame(width: w, height: h)
            .overlay(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    ForEach(humps) { hump in
                        Circle()
                            .fill(Color.white)
                            .frame(width: hump.size, height: hump.size)
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
