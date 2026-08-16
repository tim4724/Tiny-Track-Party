import SwiftUI
import UIKit

/// The attribution list, and the license texts it drills into.
///
/// **This board is an obligation, not a courtesy.** The race music is CC-BY (the
/// credit IS the licence condition), the two fonts are OFL and Filament,
/// openlibm, double-conversion, LiveKit's WebRTC and SwiftDraw all demand their
/// notice travel with the build. A shell that ships those and shows nobody is
/// in breach, which is why this exists on a TV at all.
///
/// **NOTHING HERE IS TYPED.** `Legal.entries` is baked from
/// `public/shared/credits.js` plus the live music catalogue by
/// `shells/tvos/scripts/gen-legal.mjs` — the same two modules the web's
/// /licenses.html renders — with the delta between what a browser ships and what
/// an .ipa ships applied in one place. A song added to a biome pool appears here
/// on the next stage with nothing edited.
///
/// The rows are grouped exactly as the web page groups them (`SECTION_ORDER`),
/// and the ORDER inside a section is the shared data's own.
@MainActor
struct LicensesView: View {

    /// Every row is focusable, including the ones with no text to drill into.
    /// That is not decoration: a tvOS `ScrollView` scrolls by revealing the
    /// FOCUSED view, so an unfocusable row is a row the remote cannot reach —
    /// and the music (which needs no text) leads the list, so a display-only
    /// row would strand everything below it.
    @FocusState private var focusedRow: Legal.Entry.ID?

    var body: some View {
        LegalBoard(title: Copy.licenses) { _ in
            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(Legal.entries.enumerated()), id: \.element.id) { index, entry in
                        if index == 0 || Legal.entries[index - 1].section != entry.section {
                            StickerPill(entry.section, tint: Tokens.purple, size: 20)
                                .padding(.top, index == 0 ? 0 : 18)
                        }
                        row(entry, index: index)
                    }
                }
                // Room for the focused row's heavier edge and its hard shadow:
                // a ScrollView clips at its bounds, and both sit outside the
                // row's own box.
                .padding(.horizontal, 4)
                .padding(.trailing, 10)
                .padding(.vertical, 8)
            }
        }
        // Seat the remote on the first row, so the list is live on arrival and
        // the board does not need a press to wake up.
        .onAppear { focusedRow = Legal.entries.first?.id }
    }

    /// A row drills in only when this build actually SHIPS the text (the
    /// notice-tier licenses). A CC0 or CC-BY row has no page behind it, and one
    /// that opened onto a repeat of its own three facts would be a door to
    /// nowhere — so those rows are focusable, readable, and do nothing on Select.
    @ViewBuilder
    private func row(_ entry: Legal.Entry, index: Int) -> some View {
        if entry.notice != nil {
            NavigationLink(value: GameState.InfoRoute.license(index)) {
                LicenseRow(entry: entry, drillsIn: true, focused: focusedRow == entry.id)
            }
            .buttonStyle(BareRowStyle())
            .focusEffectDisabled()
            .focused($focusedRow, equals: entry.id)
        } else {
            LicenseRow(entry: entry, drillsIn: false, focused: focusedRow == entry.id)
                .focusable()
                .focusEffectDisabled()
                .focused($focusedRow, equals: entry.id)
        }
    }
}

/// Hands the label through untouched.
///
/// **`.plain` IS NOT NOTHING on tvOS.** `PlainButtonStyle` draws its own focus
/// background — a hard-edged white slab sized to the layout frame — and
/// `.focusEffectDisabled()` does not suppress it, because it is the STYLE's
/// drawing rather than the system focus effect. It showed up as a white
/// rectangle sticking out from behind every focused row that drills in (the
/// Fonts section down), while the music rows above looked right because they are
/// plain focusable views and not buttons at all. A style that returns the label
/// is the only "no dressing" there is; the row draws its own focus state.
private struct BareRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

/// One credit: what it is and who made it on the left, what it is licensed under
/// on the right — the same two columns the web page's `.entry` row has.
///
/// **FOCUS FILLS THE ROW BLUE**, and it has to go that far. The kit's every
/// other control says focus by lifting and brightening, and neither is available
/// here: a row is as wide as the list, so `Sticker.focusScale` pushes it past
/// the ScrollView's bounds, WHICH CLIP (the focused row came back cropped at
/// both ends, and the top one lost its first character), and brightening a white
/// sticker on warm paper does nothing you can see from a sofa — a warmed fill
/// plus a thickened edge was the first cut, and it read as no highlight at all.
///
/// So the row swaps face and type together, the way the lobby's ⓘ does when the
/// remote lands on it: blue is what "you are here" looks like across this whole
/// info branch (the ⓘ, the Licenses button, the two card labels), it is a chrome
/// colour the theme allows, and it needs no room the row does not already have.
@MainActor
private struct LicenseRow: View {
    let entry: Legal.Entry
    let drillsIn: Bool
    let focused: Bool

    var body: some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title)
                    .font(Fonts.display(26, weight: .bold))
                    .foregroundStyle(focused ? .white : Tokens.ink)
                    .lineLimit(1)
                Text(entry.author)
                    // Not `ink-3` on blue: the quiet grey a white card wants is
                    // barely there against it, and the author is half of what
                    // the attribution actually says.
                    .font(Fonts.display(20, weight: .semibold))
                    .foregroundStyle(focused ? Color.white.opacity(0.85) : Tokens.ink3)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // The pill stays INK on both faces. It is the one token on the row
            // that means something specific (the licence), and a pill that
            // recoloured with the focus would read as part of the highlight.
            StickerPill(entry.license, tint: Tokens.ink, size: 17)
            // The chevron is the whole of the affordance: it says which rows
            // have a page behind them, so a row that does nothing on Select
            // never looked like it should have.
            Text(drillsIn ? "›" : " ")
                .font(Fonts.display(28, weight: .bold))
                .foregroundStyle(focused ? .white : Tokens.ink3)
                .frame(width: 18)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)
                .fill(focused ? Tokens.blue : Tokens.surface)
                .hardShadow(focused ? Sticker.focusShadow : Sticker.popShadow)
        )
        .stickerOutline(focused ? Sticker.border : Sticker.hairlineBorder, radius: Sticker.radius)
        .animation(.easeOut(duration: 0.12), value: focused)
        .accessibilityElement(children: .combine)
    }
}

/// One license text, full screen and scrolling on its own.
///
/// A license is only a notice while it is INTACT, so the text is shown verbatim,
/// in a monospace face at the pitch it was hard-wrapped for. Nothing here
/// reflows, truncates or paraphrases it.
@MainActor
struct LicenseTextView: View {
    let index: Int

    var body: some View {
        let entry = Legal.entries[min(max(index, 0), Legal.entries.count - 1)]
        LegalBoard(title: entry.title) { height in
            if let text = Self.notice(entry) {
                LicenseText(text: text, viewportHeight: height)
            } else {
                // The staged file is missing, which is a build fault (the
                // generator names only files it copied). Say so on the screen
                // rather than showing an empty board that reads as "no licence".
                Text(entry.licenseURL)
                    .font(Fonts.display(24, weight: .semibold))
                    .foregroundStyle(Tokens.ink3)
            }
        }
    }

    /// The notice as staged into the bundle by `gen-legal.mjs`, under the name
    /// the generated entry carries.
    private static func notice(_ entry: Legal.Entry) -> String? {
        guard let name = entry.notice else { return nil }
        let stem = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        guard let url = Bundle.main.url(forResource: stem, withExtension: ext,
                                        subdirectory: "assets/licenses"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return text
    }
}

/// The text, sliced into half-viewport blocks that are each an invisible focus
/// stop, so the FOCUS ENGINE does the scrolling: Down moves to the next block
/// and the ScrollView reveals it, which advances the page by half a screen.
///
/// That is not a workaround, it is how tvOS scrolls — a ScrollView moves to
/// reveal the focused view and there is no other lever, and neither a
/// `.focusable()` ScrollView nor a UIKit text view scrolls on the remote.
/// BLOCKS rather than paragraphs because paragraph heights are uneven, and a
/// list of them lurches a line at a time through the short ones. (This mechanism
/// comes from the same problem solved in HexStacker's TV shell.)
@MainActor
private struct LicenseText: View {
    let text: String
    let viewportHeight: CGFloat

    /// Monospace at 26pt: display faces are unreadable at license length, and
    /// these texts are hard-wrapped for a fixed pitch — a proportional face
    /// makes their ragged right edge look like damage.
    private static let size: CGFloat = 26
    private static let lineHeight = UIFont(name: "Menlo", size: size)?.lineHeight ?? size * 1.21

    private var blocks: [String] {
        let lines = text.components(separatedBy: "\n")
        let per = max(4, Int((viewportHeight * 0.5) / Self.lineHeight))
        return stride(from: 0, to: lines.count, by: per).map {
            lines[$0..<min($0 + per, lines.count)].joined(separator: "\n")
        }
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            // No spacing and no decoration between blocks: they are slices of
            // ONE text, so any gap would show up as a seam mid-paragraph.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, chunk in
                    Text(chunk)
                        .font(.custom("Menlo", size: Self.size))
                        .foregroundStyle(Tokens.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .focusable()
                        .focusEffectDisabled()
                }
            }
        }
    }
}

/// The chrome both legal boards wear: paper, a title sticker, and the body
/// sized by a reader so the text page can slice against a real height.
///
/// Paper rather than floating over the live 3D, because these are full-screen
/// BOARDS in the project's own sense: chrome floats bare over the scene, boards
/// stand on paper.
@MainActor
private struct LegalBoard<Content: View>: View {
    let title: String
    @ViewBuilder let content: (CGFloat) -> Content

    var body: some View {
        PaperStage {
            VStack(alignment: .leading, spacing: 18) {
                Text(title)
                    .font(Fonts.display(40, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .padding(.vertical, 10)
                    .padding(.horizontal, 24)
                    .background(
                        RoundedRectangle(cornerRadius: Sticker.radius, style: .continuous)
                            .fill(Tokens.red)
                            .hardShadow(Sticker.cardShadow)
                    )
                    .stickerOutline(Sticker.border, radius: Sticker.radius)
                    .rotationEffect(.degrees(-1.2))

                GeometryReader { geo in content(geo.size.height) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, 60)
            .padding(.vertical, 28)
        }
    }
}
