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
/// **EVERY ROW OPENS.** A browser gets a link on each licence chip — the served
/// notice where one is shipped, else the canonical URL (`public/licenses.js`) —
/// and a television cannot follow either, so a CC-BY or CC0 row used to name its
/// licence and give the room no way to read it. Rows under a notice-tier licence
/// open the notice this build ships; the rest open the licence's own text, one
/// shared copy per id (`shells/licenses/`). Which of the two a row has is the
/// generator's business, not this file's.
///
/// **NOTHING HERE IS TYPED.** `Legal.entries` is baked from
/// `public/shared/credits.js` plus the live music catalogue by
/// `shells/tvos/scripts/gen-legal.mjs` — the same two modules the web's
/// /licenses.html renders — with the delta between what a browser ships and what
/// an .ipa ships applied in one place. A song added to a biome pool appears here
/// on the next stage with nothing edited.
///
/// The rows are grouped exactly as the web page groups them (`SECTION_ORDER`),
/// and the ORDER inside a section is the shared data's own: ONE paper card per
/// section, its name a label at the card's corner, its rows printed on it and
/// ruled apart — the web page's `.sec` cards, in one column.
@MainActor
struct LicensesView: View {

    /// Every row is focusable, including the ones with no text to drill into.
    /// That is not decoration: a tvOS `ScrollView` scrolls by revealing the
    /// FOCUSED view, so an unfocusable row is a row the remote cannot reach —
    /// and the music (which needs no text) leads the list, so a display-only
    /// row would strand everything below it.
    @FocusState private var focusedRow: Legal.Entry.ID?

    /// A section's label colour, by its index: the web's `.sec:nth-child`
    /// cycle, so Music is red, 3D models blue, Sound effects purple, Fonts
    /// green, and the cycle starts over.
    private static let sectionColors = [Tokens.red, Tokens.blue, Tokens.purple, Tokens.green]

    /// `Legal.entries` cut into its runs of one section, each row keeping its
    /// index in the flat list — the index is what the drill-in route carries.
    private struct Section: Identifiable {
        let name: String
        var rows: [(index: Int, entry: Legal.Entry)]
        var id: String { name }
    }

    private static let sections: [Section] = Legal.entries.enumerated().reduce(into: []) { out, item in
        if out.last?.name == item.element.section {
            out[out.count - 1].rows.append((item.offset, item.element))
        } else {
            out.append(Section(name: item.element.section, rows: [(item.offset, item.element)]))
        }
    }

    /// The title is the list's FIRST ITEM, not a fixed header, so it scrolls
    /// away with the page, and the cards run under the screen edges instead of
    /// being cut off one inset in. The first screen is the same picture either
    /// way. (Android's twin does the same; the licence TEXT page keeps its
    /// fixed title on both.)
    var body: some View {
        PaperStage {
            // The scroll view's FRAME stays on the safe area, which is what the
            // focus engine scrolls the focused row into, so a row is never
            // brought to rest under a bezel that crops. Its DRAWING is not
            // clipped there: the content runs on to the screen edges. Reaching
            // past the safe area with `ignoresSafeArea` instead moved the first
            // screen up by the inset, title and all.
            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 24) {
                    LegalTitle(text: Copy.licenses)
                        .padding(.bottom, LegalTitle.gap - 24)
                    ForEach(Array(Self.sections.enumerated()), id: \.element.id) { i, section in
                        card(section, color: Self.sectionColors[i % Self.sectionColors.count])
                    }
                }
            }
            .scrollClipDisabled()
        }
        // Seat the remote on the first row, so the list is live on arrival and
        // the board does not need a press to wake up.
        .onAppear { focusedRow = Legal.entries.first?.id }
    }

    private func card(_ section: Section, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            StickerPill(section.name, tint: color, size: 16.5)
                .padding(.top, 6)
                .padding(.bottom, 12)
                .padding(.leading, 9)
            ForEach(Array(section.rows.enumerated()), id: \.element.entry.id) { n, row in
                // The rule ABOVE each row parts it from the one before: none on
                // the first, and none either side of the focused one, whose
                // wash is its own edge.
                let focused = focusedRow == row.entry.id
                let ruled = n > 0 && !focused && focusedRow != section.rows[n - 1].entry.id
                link(row.entry, index: row.index, focused: focused, ruled: ruled)
            }
        }
        .padding(.vertical, 18)
        .padding(.horizontal, 21)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Sticker.radiusLarge, style: .continuous)
            .fill(Tokens.surface))
    }

    /// Every row is a link, because every entry has a text behind it — see the
    /// board's own header. It used to branch on `notice`, leaving CC0 and CC-BY
    /// rows focusable but inert; what that cost was not the press, it was that
    /// the majority of this list was terms the room could not read.
    private func link(_ entry: Legal.Entry, index: Int, focused: Bool, ruled: Bool) -> some View {
        NavigationLink(value: GameState.InfoRoute.license(index)) {
            LicenseRow(entry: entry, focused: focused, ruled: ruled)
        }
        .buttonStyle(BareRowStyle())
        .focusEffectDisabled()
        .focused($focusedRow, equals: entry.id)
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

/// One credit on ONE line: what it is, then who made it, then what it is
/// licensed under against the right edge — the web page's `.entry` row.
///
/// The rows are printed on their section's card, not cards of their own, and
/// **FOCUS IS THE PICK**: the row washed blue with a blue ring inside its own
/// box. It is the one focus signal available here, because the lift is not: a
/// row is as wide as the list, so `Sticker.focusScale` pushes it past the
/// ScrollView's bounds, WHICH CLIP (the focused row came back cropped at both
/// ends, and the top one lost its first character).
@MainActor
private struct LicenseRow: View {
    let entry: Legal.Entry
    let focused: Bool
    let ruled: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 21, style: .continuous)
        return HStack(spacing: 15) {
            HStack(alignment: .firstTextBaseline, spacing: 15) {
                // The title gives way first: a long one ellipsises, and the
                // author beside it — half of what the attribution says — stays.
                Text(entry.title)
                    .font(Fonts.display(24, weight: .semibold))
                    .foregroundStyle(Tokens.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(entry.author)
                    .font(Fonts.body(19.5, weight: .bold))
                    .foregroundStyle(Tokens.ink2)
                    .lineLimit(1)
                    .fixedSize()
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // A grey LABEL: the licence is a fact about the row, not a colour.
            StickerPill(entry.license, size: 15)
                .fixedSize()
            // The chevron says the row opens, which every row does. It is the
            // only mark on the row that says a press does anything at all.
            Image(systemName: "chevron.right")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(Tokens.ink3)
        }
        .padding(.vertical, 18)
        .padding(.horizontal, 21)
        .background(shape.fill(focused ? Tokens.pick : Color.clear))
        .overlay {
            if focused { shape.strokeBorder(Tokens.blue, lineWidth: Sticker.ring) }
        }
        .overlay(alignment: .top) {
            if ruled { Rectangle().fill(Tokens.hairline).frame(height: 2) }
        }
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
            if let text = Self.text(entry) {
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

    /// The text as staged into the bundle by `gen-legal.mjs`, under the name the
    /// generated entry carries. Nil only when the staged file is missing, which
    /// is a build fault — the generator copies exactly the set the entries name.
    private static func text(_ entry: Legal.Entry) -> String? {
        let name = entry.text
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

/// The licence text page's chrome: paper, a fixed plain ink title, and the body
/// sized by a reader so the text can slice against a real height.
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
            // The content sits on the system safe area (90 x 60 points) and no
            // further in: that IS the board's margin.
            VStack(alignment: .leading, spacing: LegalTitle.gap) {
                LegalTitle(text: title)
                GeometryReader { geo in content(geo.size.height) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

/// Both legal boards' title: plain ink, top-left.
private struct LegalTitle: View {
    let text: String

    /// Title to body, on both legal boards.
    static let gap: CGFloat = 30

    var body: some View {
        Text(text)
            .font(Fonts.display(60, weight: .bold))
            .foregroundStyle(Tokens.ink)
            .lineLimit(1)
    }
}
