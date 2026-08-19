import SwiftUI

/// The frame-cost readout, and the tvOS half of `render/PerfHud.js`.
///
/// **IT MEASURES; IT DOES NOT JUDGE.** The ring, its trim, the warm-up filter,
/// the two rates, the percentiles, the drop and skip counts and the health
/// verdict are all `ttp_perf.h` (`libttp-runtime/ttp/perf_stats.h` carries the
/// reasoning, and the `perf` ctest executes it on every leg). What is left here
/// is what only this platform can do: read `CADisplayLink`'s clock and the
/// renderer's profile buffer, hand them over, and draw the answer. Three
/// hand-written folds used to sit in three shells, each with a comment claiming
/// they agreed, and by the time they were replaced this one folded skipped
/// presents into its verdict and the other two did not — so the same run was
/// amber on a television and green in a browser.
///
/// NO GPU NUMBER CROSSES FROM HERE, and it is passed as ABSENT rather than as
/// zero, because a platform with no timer has no signal and not a free frame.
/// `ttp_display_gpu_ms()` is real "on the GL backend where
/// EXT_disjoint_timer_query exists" (its own header) — Metal is not that
/// backend, and whether Filament's Metal backend can be made to answer a frame
/// duration at all is UNPROVEN on this box. Absent is the honest report until
/// somebody proves otherwise on the hardware, and it is not a free choice: with
/// no GPU stat the verdict's overshoot term falls back to the present
/// interval's p95, so a plausible substitute would silently move the bar.
///
/// ON DURING DEVELOPMENT, exactly as the web's is. `GameCoordinator.boot()`
/// calls `show()`, and that one line is what to delete for release — everything
/// below is inert while hidden, `record` returning before it touches the perf
/// ABI at all. There is deliberately no hide and no toggle: every button this
/// shell can reach on the Siri Remote is already spoken for (Menu walks back,
/// Play/Pause is the pause, select and the d-pad belong to the focus chain), so
/// a debug toggle could only be built by taking one of them off a player. The
/// web's "P" key and Android's KEYCODE_INFO cost their platforms nothing; here
/// the switch is the boot line.
@MainActor
final class PerfMonitor: ObservableObject {

    /// Published at 4 Hz, not 60: an `@Published` write per frame would redraw
    /// the overlay as often as the scene it is measuring.
    private static let textInterval = 0.25
    /// The bench contract's cadence — one `TtpPerf <json>` line a second, the
    /// same on all three shells so one parser reads all three logs.
    private static let logInterval = 1.0

    @Published private(set) var visible = false
    @Published private(set) var lines: [String] = []
    @Published private(set) var tint = Color.green

    private var lastText: Double = 0
    private var lastLog: Double = 0
    private var benching = false
    /// What is being driven, for a sweep that spans a catalogue. Only a bench
    /// knows it (the driver names the circuit); a party run reports null.
    private var track: String?
    private var totalIndex: Int?
    private var namesResolved = false

    /// Switch the readout on.
    func show() {
        visible = true
        lastText = 0
        reset()
    }

    /// Drop the shared window — stale history is worse than none. Called
    /// whenever what is being measured changes underneath: the readout coming
    /// on, a resize and a scene build (`DisplayHost.applyResize` and `build`).
    func reset() { ttp_perf_reset() }

    /// Start a BENCHED run on `track`: the same readout, additionally logged
    /// once a second as `TtpPerf <json>` — one JSON object per line, the very
    /// bytes the panel above is drawn from, so a screenshot and a logged number
    /// cannot disagree. `Log.i("TtpPerf", …)` on Android and `console.log` on
    /// the web emit the identical shape; `scripts/perf-race.tvos.mjs` reads this
    /// one back off `devicectl --console`.
    func bench(track: String) {
        benching = true
        self.track = track.isEmpty ? nil : track
        lastLog = 0
        show()
    }

    /// One display-link TICK, drawn or not. `interval` is the elapsed time since
    /// the previous tick (not the link's nominal cadence), because a missed
    /// vsync is exactly what this is here to show; `presented` is whether that
    /// tick put a new picture on the panel.
    func record(now: Double, interval: Double, presented: Bool,
                cells: Int, pixels: CGSize, dpr: CGFloat) {
        guard visible else { return }
        // SECONDS on this side, MILLISECONDS on that one: `CADisplayLink`
        // timestamps are seconds and `ttp_perf_sample` takes ms.
        //
        // The cpu sample is dropped (0, i.e. absent) on a skip rather than
        // repeated: the renderer returns before writing its `total`, so the
        // profile still holds the last DRAWN frame, and folding it in again
        // would weight the median hardest under exactly the load that causes
        // skips. The gpu argument is absent always — see the header.
        ttp_perf_sample(now * 1000, interval * 1000, presented ? 1 : 0,
                        presented ? (cpuTotalMs() ?? 0) : 0, 0)
        guard now - lastText >= Self.textInterval else { return }
        lastText = now
        publish(now: now, cells: cells, pixels: pixels, dpr: dpr)
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

    /// ONE readout, drawn and logged. The buffer size and the CELL COUNT ride it
    /// because GPU cost scales with cells and pixels together: a logged number
    /// carrying neither is not comparable to any other logged number. They are
    /// not in the drawn rows — a human looking at the television can already see
    /// how many cells are on it.
    private func publish(now: Double, cells: Int, pixels: CGSize, dpr: CGFloat) {
        let json = TTP.strOrEmpty(ttp_perf_readout_json(
            Int32(cells), Int32(pixels.width), Int32(pixels.height), Double(dpr), track))
        if benching && now - lastLog >= Self.logInterval {
            lastLog = now
            print("TtpPerf \(json)")
        }
        let r = TTP.obj(json)
        let w = num(r["width"]), h = num(r["height"])
        // WARMING IS NOT A FRAME RATE (perf_stats.h): the first presents of a run
        // are shader compiles and first uploads, and the fold discards them
        // rather than reporting them. Saying so beats drawing 0/0 fps, which a
        // viewer reads as a stall in the one second where it never is.
        guard !(r["warming"] as? Bool ?? false) else {
            lines = ["\(w)×\(h)", "warming up"]
            tint = Self.good
            return
        }
        let fps = num(r["fps"]), hz = num(r["hz"])
        let skips = num(r["skips"]), drops = num(r["drops"])
        // Cost as a SHARE OF BUDGET USED, low is good, the same sense as the
        // web's readout. With no GPU number to set beside it this is a FLOOR on
        // the frame's cost and not the whole of it.
        let budget = r["budgetMs"] as? Double ?? 0
        let p50 = (r["cpu"] as? [String: Any])?["p50"] as? Double
        let cpuText = (budget > 0 ? p50.map { "\(Int((100 * $0 / budget).rounded()))%" } : nil) ?? "n/a"
        // TWO ROWS, the two the web settled on: the surface and the cadence on
        // one line, the cost on the other. `fps/hz` rather than one rate because
        // the PAIR is the diagnosis — 60/60 is a healthy panel, 41/60 is a GPU
        // that cannot hold this resolution, and one number cannot tell them
        // apart at all.
        lines = [
            "\(w)×\(h) · \(fps)/\(hz) fps · "
                + "\(skips) skip\(skips == 1 ? "" : "s") · \(drops) drop\(drops == 1 ? "" : "s")",
            "cpu \(cpuText)"
        ]
        // DIAGNOSTIC colours, not chrome: the sticker palette's veto on amber
        // does not reach a debug overlay, and the three readouts agreeing is
        // worth more here than any of them matching the theme.
        switch r["verdict"] as? String {
        case "bad": tint = Color(red: 1, green: 0.42, blue: 0.42)
        case "warn": tint = Color(red: 1, green: 0.82, blue: 0.4)
        default: tint = Self.good
        }
    }

    private static let good = Color(red: 0.49, green: 0.99, blue: 0.54)

    /// A count out of the readout. `JSONSerialization` hands every number back
    /// as an `NSNumber`, and the readout's counts are whole by construction.
    private func num(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }
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
