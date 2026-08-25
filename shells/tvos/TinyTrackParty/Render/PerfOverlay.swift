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
/// THE GPU NUMBER IS REAL HERE NOW, and it took a Filament fork commit to make
/// it so. `MetalTimerQueryFence` measured the interval between two shared-event
/// fence signals with `clock::now()` — CPU wall time between two points in the
/// submission stream, which under vsync tracks the PRESENT CADENCE and not the
/// work. It reported about 16.7 ms for every frame a 60 Hz panel delivered,
/// idle or saturated, so feeding it in would have been worse than absent: a
/// number that is always exactly the budget is a number that always says
/// "late". The pinned fork takes GPUStartTime/GPUEndTime off the command
/// buffers instead (native/filament.pin; upstream PR google/filament#10338).
///
/// IT IS NOT ONLY A READOUT. The render scale folds off this same monitor, so
/// what is passed here steers the television's resolution — which is why this
/// arrived WITH `render_scale.h`'s present-record veto and not before it. On
/// this device the GPU p95 at 4 players sits past the down threshold while the
/// box presents 60/60 with zero skips, and without that veto, wiring the timer
/// in cost a whole rung of picture.
///
/// Absent (<= 0) is still the honest report for a platform with no timer, and
/// it is not a free choice: with no GPU stat the verdict's overshoot term falls
/// back to the present interval's p95, so a plausible substitute would silently
/// move the bar.
///
/// OFF UNTIL ASKED FOR, as the web's and Android's are. `-ttpPerf 1` at launch
/// is the switch ([enabledAtLaunch]) and `GameCoordinator.boot()` reads it;
/// everything below is inert while hidden, and the CPU term is not even sampled.
///
/// A LAUNCH ARGUMENT AND NOT A BUTTON, which is this platform's constraint and
/// not a preference: every button the Siri Remote can reach is already spoken
/// for (Menu walks back, Play/Pause is the pause, select and the d-pad belong to
/// the focus chain), so a toggle could only be built by taking one off a player.
/// It is the same knob shape as `-ttpRenderScale` and `-ttpFeatures`
/// (`DisplayHost`), it survives a force-stop the way a keypress would not, and
/// the bench turns the panel on for itself ([bench]) without being asked.
@MainActor
final class PerfMonitor: ObservableObject {

    /// Published at 4 Hz, not 60: an `@Published` write per frame would redraw
    /// the overlay as often as the scene it is measuring.
    private static let textInterval = 0.25
    /// The bench contract's cadence — one `TtpPerf <json>` line a second, the
    /// same on all three shells so one parser reads all three logs.
    private static let logInterval = 1.0

    /// `-ttpPerf 1`: put the readout up for this launch. Absent means off, which
    /// is what a player gets — a television is not a browser with a console, and
    /// a diagnostic block over the corner of the picture is the whole of what
    /// they would see of it.
    ///
    /// LIVE IN RELEASE ON PURPOSE, exactly as Android's `debug.ttp.*` knobs are:
    /// the build that ships is the only one with the real optimisation level, and
    /// an instrument compiled out of it cannot measure the thing people run.
    static let enabledAtLaunch = UserDefaults.standard.bool(forKey: "ttpPerf")

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
    /// on, a resize and a scene build (`DisplayHost.applyResize` and `sceneBuilt`).
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
        // FED WHETHER OR NOT ANYONE IS WATCHING. The render scale folds off this
        // same monitor (`ttp_perf.h`), so a window kept only while the panel is
        // up would leave the rule deciding a television's resolution off an
        // empty ring the moment someone pressed the toggle. The cost of the
        // sample is a push into a 120-frame ring; the cost of this object is
        // `publish`, which is behind the interval below.
        //
        // SECONDS on this side, MILLISECONDS on that one: `CADisplayLink`
        // timestamps are seconds and `ttp_perf_sample` takes ms.
        //
        // The cpu sample is dropped (0, i.e. absent) on a skip rather than
        // repeated: the renderer returns before writing its `total`, so the
        // profile still holds the last DRAWN frame, and folding it in again
        // would weight the median hardest under exactly the load that causes
        // skips. It is also absent while nothing is drawing the readout, since
        // it feeds no other reader.
        //
        // THE GPU SAMPLE IS FED WHENEVER A FRAME DREW, watched or not, because
        // unlike the cpu one it has a second reader: the render scale. Gating it
        // on the panel being up would hand the rule a different signal depending
        // on whether anybody was looking at it.
        ttp_perf_sample(now * 1000, interval * 1000, presented ? 1 : 0,
                        presented && visible ? (cpuTotalMs() ?? 0) : 0,
                        presented ? ttp_display_gpu_ms() : 0)
        guard visible, now - lastText >= Self.textInterval else { return }
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
        // web's readout.
        let budget = r["budgetMs"] as? Double ?? 0
        let share = { (stat: String) -> Double? in
            guard budget > 0, let s = (r[stat] as? [String: Any])?["p50"] as? Double,
                  s > 0 else { return nil }
            return s
        }
        let pct = { (ms: Double?) in ms.map { "\(Int((100 * $0 / budget).rounded()))%" } ?? "n/a" }
        let cpuText = pct(share("cpu"))
        // THE GPU COST CARRIES ITS MILLISECONDS TOO, which the web's readout does
        // not. A browser has devtools a keypress away; a television has this
        // panel and nothing else, and the share alone hides the thing this
        // platform most needs to see — the A10X downclocks whenever a frame
        // leaves idle, so the same picture prices differently at 60 fps than it
        // does under load, and a percentage of a budget that also moved with the
        // present rate cannot show that. Absent on a platform with no timer,
        // which is what "n/a" means here and not "free".
        let gpuMs = share("gpu")
        let gpuText = gpuMs.map { "\(pct($0)) (\(String(format: "%.1f", $0)) ms)" } ?? "n/a"
        // TWO ROWS, the two the web settled on: the surface and the cadence on
        // one line, the cost on the other. `fps/hz` rather than one rate because
        // the PAIR is the diagnosis — 60/60 is a healthy panel, 41/60 is a GPU
        // that cannot hold this resolution, and one number cannot tell them
        // apart at all.
        lines = [
            "\(w)×\(h) · \(fps)/\(hz) fps · "
                + "\(skips) skip\(skips == 1 ? "" : "s") · \(drops) drop\(drops == 1 ? "" : "s")",
            // BOTH COSTS AS A SHARE OF BUDGET USED, low is good, and in the
            // web's order (gpu first): they do NOT sum — the CPU builds frame
            // N's commands while the GPU still draws N-1 — so the larger of the
            // two is the one to cut, and reading them off two shells has to be
            // the same motion.
            "gpu \(gpuText) · cpu \(cpuText)"
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
