import SwiftUI

/// The frame-cost readout, and the tvOS half of `render/PerfHud.js`.
///
/// TWO CLOCKS AND A VERDICT, and they do not measure the same thing. The display
/// link's INTERVAL is the cadence the TV ran at — under vsync it is a plateau, so
/// on its own it says nothing about headroom, but it is the only thing that says
/// whether a budget was MISSED, which is the part a human feels. CPU is
/// `ttp_display_profile`'s `total`: the C++ building this frame's input from the
/// live `Game` and issuing its draws.
///
/// The verdict is `ttp_display_frame`'s return, and WITHOUT IT THE OTHER TWO LIE.
/// The link ticks at the panel's rate whether or not a frame was drawn, so a
/// tick-counting rate reads a flat 60 through any number of pacing skips, and
/// the profile is worse than flat: the renderer returns before writing `total`
/// on a skip, so a skipped tick re-reports the last DRAWN frame's cost. Both
/// numbers therefore look healthy exactly when the GPU has stopped keeping up,
/// which is the stutter-with-no-explanation `TtpRendererFrame.cpp`'s pacing note
/// describes. That is why `fps` counts presents and `hz` counts ticks: when they
/// separate, the GPU is the reason.
///
/// THERE IS NO GPU NUMBER HERE, unlike the web. That one comes from a WebGL
/// timer query the shell could wrap around `ttp_display_frame`; on Metal the
/// command buffers are Filament's and the shell holds no handle to them, so
/// there is nothing to bracket. Do NOT reach for
/// `Renderer::getFrameInfoHistory()` to fill the gap — that is the trap the web
/// HUD's header documents, and it would need an ABI it does not have.
///
/// ON DURING DEVELOPMENT, exactly as the web's is (`render/PerfHud.js` shows
/// itself in its constructor; the "P" key hides it). `GameCoordinator.boot()`
/// calls `show()`, and that one line is what to delete for release — everything
/// below is inert while hidden, `record` returning before it touches the profile
/// ABI at all. It shipped switched OFF, which is a debug surface that exists in
/// the tree and cannot be seen on the device it was built for.
@MainActor
final class PerfMonitor: ObservableObject {

    /// The bar, and the denominator of every percentage. A CONSTANT 60 Hz
    /// budget, deliberately not the panel's real rate: a percentage is cost over
    /// budget, and a fixed denominator serves that exactly as well. KNOWN AND
    /// ACCEPTED: a 50 Hz TV (PAL match mode) presents below 60 however idle the
    /// box is, so it sits amber permanently — the cost line beside it still
    /// reads healthy, which keeps the picture legible.
    private static let budget = 1.0 / 60.0
    private static let window = 120     // frames folded into the stats
    private static let textInterval = 0.25

    @Published private(set) var visible = false
    @Published private(set) var lines: [String] = []
    @Published private(set) var tint = Color.green

    private var frames: [(t: Double, interval: Double, presented: Bool, cpu: Double?)] = []
    private var lastText: Double = 0
    private var totalIndex: Int?
    private var namesResolved = false

    func show() { visible = true; frames = []; lastText = 0 }   // stale history is worse than none
    func hide() { visible = false }
    func toggle() { if visible { hide() } else { show() } }

    /// One display-link TICK, drawn or not. `interval` is the elapsed time since
    /// the previous tick (not the link's nominal cadence), because a missed vsync
    /// is exactly what this is here to show; `presented` is whether that tick put
    /// a new picture on the panel.
    ///
    /// The cpu sample is dropped on a skip rather than repeated. The renderer
    /// returns before writing its `total`, so the profile still holds the last
    /// DRAWN frame — folding it in again would weight the median with a frame
    /// that was never built, and weight it hardest under exactly the load that
    /// causes skips.
    func record(now: Double, interval: Double, presented: Bool, cells: Int, pixels: CGSize) {
        guard visible else { return }
        frames.append((now, interval, presented, presented ? cpuTotalMs() : nil))
        if frames.count > Self.window { frames.removeFirst(frames.count - Self.window) }
        // Published at 4 Hz, not 60: an @Published write per frame would redraw
        // the overlay as often as the scene it is measuring.
        guard now - lastText >= Self.textInterval else { return }
        lastText = now
        paint(now: now, cells: cells, pixels: pixels)
    }

    /// Last frame's CPU total, out of the renderer's own strided profile array.
    /// The section names are fixed for the life of the process, so the index is
    /// resolved once rather than re-split per frame.
    private func cpuTotalMs() -> Double? {
        if !namesResolved {
            namesResolved = true
            totalIndex = TTP.strOrEmpty(ttp_display_profile_names())
                .split(separator: Character(",")).map(String.init).firstIndex(of: "total")
        }
        guard let i = totalIndex, let profile = ttp_display_profile() else { return nil }
        return profile[i]
    }

    /// Budgets missed by a frame that took `interval`. Rounded rather than
    /// floored: presents land on vsyncs, so a 25 ms interval is a frame that
    /// slipped one budget, not 1.5 of them.
    private func missed(_ interval: Double) -> Int {
        guard interval > 0 else { return 0 }
        return max(0, Int((interval / Self.budget).rounded()) - 1)
    }

    private func paint(now: Double, cells: Int, pixels: CGSize) {
        // fps and the drop count are both windowed over the trailing SECOND,
        // which is the span a human can act on; the cost stats fold the whole
        // ring, because a p50 over 16 frames is noise.
        let recent = frames.filter { $0.t > now - 1.0 }
        let span = (recent.last?.t ?? 0) - (recent.first?.t ?? 0)
        // TWO RATES, because they diverge precisely when this overlay is worth
        // looking at. `hz` is how often the link ticked, which is the panel's
        // rate and stays flat under any load the CPU survives. `fps` counts only
        // the ticks that DREW, which is what a human is actually watching. Equal
        // means healthy; a gap is the GPU refusing frames, and the size of the
        // gap is how many the television never got.
        let hz = span > 0 ? Int((Double(recent.count - 1) / span).rounded()) : 0
        let drawn = recent.filter(\.presented).count
        let fps = span > 0 ? Int((Double(drawn) / span).rounded()) : 0
        let skips = recent.count - drawn
        let drops = recent.reduce(0) { $0 + missed($1.interval) }
        let cpu = median(frames.compactMap(\.cpu))
        let cpuUsed = cpu.map { $0 / 1000 / Self.budget }
        let intervals = frames.map(\.interval).sorted()
        let p95 = intervals.isEmpty ? 0 : intervals[min(intervals.count - 1, Int(Double(intervals.count) * 0.95))]

        // Cost as a SHARE OF BUDGET USED, low is good, the same sense as the
        // web's readout. There is no GPU number to sum it against here, so this
        // is a floor on the frame's cost and not the whole of it.
        let cpuText = cpuUsed.map { "\(Int(($0 * 100).rounded()))%" } ?? "n/a"
        // TWO ROWS, and the same two the web settled on: the surface and the
        // cadence on one line, the cost on the other. The CELL COUNT is
        // deliberately not among them — a human looking at the television can
        // already see how many cells are on it, and the row it used to occupy
        // was the one a viewer never read.
        //
        // `cells` stays in `record`'s signature for the same reason it stays in
        // the web's `sample()`: a SCRIPTED sweep cannot see the screen, and GPU
        // cost scales with cells and pixels together, so a logged number without
        // both is not comparable to any other logged number.
        // `fps/hz` rather than one rate: the pair is the diagnosis. 60/60 is a
        // healthy panel, 41/60 is a GPU that cannot hold this resolution, and
        // the old single number could not tell them apart at all.
        lines = [
            "\(Int(pixels.width))×\(Int(pixels.height)) · \(fps)/\(hz) fps · "
                + "\(skips) skip\(skips == 1 ? "" : "s") · \(drops) drop\(drops == 1 ? "" : "s")",
            "cpu \(cpuText)"
        ]
        // The web's thresholds, kept so the two readouts mean the same thing.
        // With no GPU timer the overshoot term is the interval's p95 past one
        // budget, which lands on the same scale: 1.0 means the slow frames take
        // two. These are DIAGNOSTIC colours, not chrome — the sticker palette's
        // veto on amber does not reach a debug overlay, and matching PerfHud.js
        // exactly is worth more here than matching the theme.
        // Skips join the ladder on the same rungs as drops: both are a budget
        // that went by with nothing new on the panel, and a viewer cannot tell
        // which mechanism cost them the frame. The `fps` terms now bite for the
        // first time — against a tick count they could only fire when the main
        // thread itself stalled, which is the one case that was never the
        // interesting one.
        let over = p95 / Self.budget - 1
        tint = (skips > 2 || drops > 2 || over > 1 || (fps > 0 && fps < 48)) ? Color(red: 1, green: 0.42, blue: 0.42)
             : (skips > 0 || drops > 0 || over > 0.7 || (fps > 0 && fps < 57)) ? Color(red: 1, green: 0.82, blue: 0.4)
             : Color(red: 0.49, green: 0.99, blue: 0.54)
    }

    private func median(_ xs: [Double]) -> Double? {
        guard !xs.isEmpty else { return nil }
        let s = xs.sorted()
        return s[s.count / 2]
    }
}

/// Drop this over the scene (`.overlay(alignment: .bottomTrailing)`); SwiftUI's
/// safe area keeps it inside the TV's overscan. It renders nothing at all while
/// the monitor is hidden.
struct PerfOverlay: View {
    @ObservedObject var monitor: PerfMonitor

    var body: some View {
        if monitor.visible {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(monitor.lines.enumerated()), id: \.offset) { Text($0.element) }
            }
            .font(.system(size: 22, weight: .semibold, design: .monospaced))
            .foregroundColor(monitor.tint)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color.black.opacity(0.58))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .allowsHitTesting(false)
        }
    }
}
