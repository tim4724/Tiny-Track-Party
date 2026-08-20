import Foundation
import QuartzCore
import UIKit

/// The browser's `Display.js` + `Stage.js` frame loop, as one object: the
/// display singleton's lifecycle, the `CADisplayLink` that drives it, and the
/// handful of latched setters the renderer takes.
///
/// **There is nothing per-frame in here but a `dt`, and that is the point.** The
/// sim and the renderer are the same library, so `ttp_display_frame` reads the
/// bound session's live `Game` in C++ and builds the renderer's input in place.
/// Nothing about a car — pose, speed, steer, which cell it owns — is ever
/// marshalled into Swift and handed back. A steady-state race frame is
/// `ttp_display_frame(dt)`, whatever the coordinator's `onFrame` does (the sim
/// tick and the audio frame), and a packed `cellRects` read. Anything tempted
/// onto that path has to be something that actually CHANGES per frame.
///
/// `ttp_display.h` is a SINGLETON ABI — one surface, one Filament engine per
/// process on every platform we ship — so this class holds no handle. The only
/// state below is what the ABI cannot be asked for: whether a display exists,
/// whether a scene is built, and the latched values, so nothing is pushed twice.
@MainActor
final class DisplayHost {

    // MARK: - Callbacks

    /// Called with this frame's `dt` in SECONDS, **before** `ttp_display_frame`.
    /// The coordinator ticks the sim here, so the frame that follows draws the
    /// state this dt produced rather than the previous one's.
    var onFrame: ((Double) -> Void)?

    /// The ~6 Hz poll (`HUD_TICK_MS`, `Stage.js`). Fires inside the frame
    /// callback and BEFORE the frame draws, which is load-bearing: the card mask
    /// this tick computes has to reach `ttp_display_cell_cards` before the
    /// renderer decides whether to draw a steer bar under it.
    var onSlowTick: (() -> Void)?

    /// Fired ONCE, the first time a built scene actually reaches the panel. The
    /// coordinator re-evaluates the backdrop on it — see `hasPainted`.
    var onFirstPaint: (() -> Void)?

    // MARK: - State the ABI cannot be asked for

    /// Whether `ttp_display_create` has succeeded. A no-display ABI is a
    /// safe no-op everywhere (`ttp_abi.h`), so this is not a guard, it is how
    /// `attach` tells a create from a resize.
    private(set) var isAttached = false

    /// Whether a scene is built — `ttp_race.h`'s `sceneReady`, which gates a
    /// launch, because four cameras pointed at nothing is what an unbuilt track
    /// looks like.
    private(set) var hasScene = false

    /// Whether a BUILT scene has ever reached the panel — the web's `sceneReady`
    /// (`main.js`), and the clause `refreshBackdrop` needs so the paper diorama
    /// does not lift off a surface with nothing on it yet.
    ///
    /// `hasScene` is the wrong question and answers a different one: it is true
    /// the instant `ttp_display_build` returns, which is before a single pixel of
    /// that track exists. Between those two moments the shell would be fading the
    /// backdrop out over an undrawn Metal layer, which is the boot flash — the
    /// web's own note calls it coming "up from black instead of from the
    /// diorama", and reveals two frames late to avoid it.
    ///
    /// ONE-SHOT, never cleared, exactly as the web's is. A later track change
    /// rebuilds under cover of a surface that is already painted, so re-arming
    /// this would put the paper back for a frame every time the host picks.
    private(set) var hasPainted = false

    /// The roster the current scene was built from, in SLOT order.
    ///
    /// This is the only mapping from a packed HUD row back to a player: the
    /// block `ttp_display_hud` answers with is indexed by slot and carries no
    /// identity, deliberately (nothing about a car is serialized out of the
    /// wasm). The shell supplied that order at build time, so the shell is what
    /// holds it.
    private(set) var roster: [EngineIdentity] = []

    /// Physical pixels per point — THIS SHELL'S OWN, and no longer told to C++.
    ///
    /// `ttp_display_ui_scale` is gone (see `ttp_display.h`): a UI point needs the
    /// panel's physical size and a viewing distance, and a TV has neither, so
    /// every platform's honest value was just its buffer-resolution ratio. The
    /// renderer's overlay sizes itself off the cell now, and every number
    /// crossing that ABI is in the surface's own physical pixels.
    ///
    /// What survives is the conversion this side has always owed: `cellRects`
    /// answers in physical pixels and SwiftUI lays out in POINTS, so the chrome
    /// still divides by this.
    ///
    /// **THE BUFFER'S pixels per point, not the PANEL's** — `adoptSurface`
    /// derives it from the drawable every time that moves, and nothing else
    /// assigns it. The two are the same number only while the buffer is the
    /// panel's own resolution; the adaptive render scale is precisely what makes
    /// them differ, and a stored `UIScreen.nativeScale` put the whole HUD at
    /// `renderScale` of its right place the first time the scale shipped.
    ///
    /// So on a 4K box it is 2.0 at the native buffer and 1.5 at the 1620 rung,
    /// which is the web's devicePixelRatio semantics applied to the buffer the
    /// web also steers. **Deliberately NOT capped at 2** — the web's cap is a
    /// hi-DPI-monitor guard and nothing here ever exceeds it anyway.
    private(set) var uiScale: CGFloat = 1

    /// The surface's size in physical pixels, for the perf readout.
    private(set) var surfacePixels: CGSize = .zero

    /// A boot failure worth surfacing. A black screen with a recorded reason
    /// beats an abort on a TV, which is the same call `ttp_display_tvos.mm`
    /// makes when it class-checks the layer.
    private(set) var lastError: String?

    /// The frame-cost readout. Off by default and inert while hidden.
    let perf = PerfMonitor()

    /// The one `MetalSurfaceView` this process has. Created lazily so the C ABI
    /// is not touched before boot, and held HERE rather than by SwiftUI because
    /// Filament takes the layer as its native window (see `MetalSurfaceView`).
    lazy var surface = MetalSurfaceView(host: self)

    // MARK: - The adaptive render scale

    // THE BUFFER IS NOT THE PANEL. `ttp/render_scale.h` decides how big it
    // should be from what the last window of frames cost. What a shell owes is
    // the MEASUREMENT and the surface's own facts, nothing else; every
    // judgement about those numbers — which signal decides, which way each may
    // move, the holds, the rungs — is the rule's. An `if` around a measurement
    // before passing it belongs in that header instead.
    //
    // ONLY THE FALLBACK IS BOUND, and the reason is FILAMENT'S, not the
    // hardware's — do not read the absent GPU column as "Metal cannot do this".
    // The good signal is GPU share of budget, the only one that can see
    // HEADROOM, and `ttp_display_gpu_ms` cannot supply it here because
    // `MetalTimerQueryFence` records `clock::now()` inside a fence COMPLETION
    // CALLBACK: host wall-clock between two callbacks, which under vsync is
    // dominated by the GPU waiting on the display. Measured on an A10X at 4
    // cells: 16.0 ms at one pass and 18.0 ms at four — it tracks the PRESENT
    // CADENCE, not the work. Passed over as 0 ("no signal") rather than as a
    // plausible substitute; `perf_stats.h` names that trap and this is it.
    //
    // THE HARDWARE ANSWERS BOTH WAYS, probed on the device (Apple A10X GPU,
    // tvOS 26.6): `MTLCommandBuffer.gpuStartTime`/`gpuEndTime` returned 0.30 ms
    // for a 4 MB blit, three runs, stable — a real GPU duration and nowhere near
    // the present interval; and `counterSets` carries "timestamp" with
    // `supportsCounterSampling(.atStageBoundary)` true. Filament even installs
    // an `addCompletedHandler` on its pending command buffer already
    // (`getPendingCommandBuffer`), which is exactly where the timestamps would
    // be read. So the missing GPU term is a FORK PATCH, not a platform limit.
    //
    // Until that lands the consequence is the rule's own, documented at its
    // fallback: late presents may only ever step DOWN, so the scale here is a
    // one-way ratchet for the life of the process.

    /// **THE SECOND WINDOW IS GONE, and it was this platform's oldest special
    /// case.** `ttp_perf_sample` takes a TICK interval ("one tick of the frame
    /// loop, drawn or not"). On the web a late present delays the next rAF, so
    /// ticks and presents are one series; a `CADisplayLink` fires every vsync
    /// whatever Filament did with the last frame, so here they are two — which is
    /// precisely why the readout carries `fps` AND `hz`. Steering off the
    /// readout's `frame` block was measured doing nothing at all: a flat 16.7 ms
    /// p95, a `latePresentRatio` pinned at 1.0, and 4 players left at 40-55 fps
    /// with the rule never firing. So this shell folded its own present series,
    /// with its own percentile, which had drifted from the one behind the very
    /// overlay it was drawn beside.
    ///
    /// The fold answers BOTH series now (`perf_stats.h`'s `Readout::present`),
    /// so there is one window again and it is the readout's. What this loop owes
    /// is `perf.record` with an honest `presented` flag, which it already gave.

    /// `-ttpRenderScale <k>` holds the buffer at k x the panel and switches the
    /// rule off — Android's `debug.ttp.scale` twin, and the same two jobs: sweep
    /// a fixed operating point, and PHOTOGRAPH the chrome at a scale the rule
    /// would otherwise have to be provoked into. The second is not optional
    /// polish; a stale `uiScale` put the whole HUD at 3/4 of its right place and
    /// nothing in the suite could see it, because every shot was taken at 1.0.
    private static let scalePin =
        max(0, min(1, UserDefaults.standard.double(forKey: "ttpRenderScale")))

    /// The scale in force. 1.0 is the panel's own resolution; this never
    /// supersamples. Read by `MetalSurfaceView` when it sizes the drawable.
    private(set) var renderScale: Double = DisplayHost.scalePin > 0 ? DisplayHost.scalePin : 1.0

    /// A scale move armed by `adaptScale`, performed at the top of a later tick.
    private var pendingScaleMove = false

    // MARK: - Latched pushes

    private var lastCellsJSON = ""
    private var cellCount = 0
    private var lastCardMask: UInt32 = 0

    /// Materials handed over before the surface existed. `ttp_display_asset`
    /// answers 0 (refused) with no display, and boot order does not guarantee
    /// that the first SwiftUI layout beats `GameCoordinator.boot()`. Every
    /// `.filamat` blob but `vcolor` degrades SILENTLY when missing — no
    /// `voverlay` and the steer bar and dividers simply vanish — so dropping
    /// them on the floor here would be invisible until someone looked at a
    /// screenshot.
    private var pendingAssets: [(String, Data)] = []

    // MARK: - The loop

    private var link: CADisplayLink?
    private var linkProxy: LinkProxy?
    private var lastTimestamp: CFTimeInterval = 0
    private var lastSlowTick: CFTimeInterval = 0
    private var inFrame = false
    private var pendingSize: CGSize?
    /// The panel period last declared to the readout, in ms. See `declarePacing`.
    private var lastPanelMs: Double = 0

    /// `Stage.js`'s clamp, for its reason: a dt of several seconds (the app
    /// resumed, the link stalled) runs the camera damping far past the car, and
    /// a negative one runs it backwards until the scene is off screen.
    private let maxFrameSeconds = 0.05

    /// `HUD_TICK_MS` (`Stage.js`), in seconds. The rate is genuinely the shell's
    /// to pick — `ttp_display_hud` is a struct read with no allocation and
    /// nothing behind it moves faster than a place does — but 160 ms is what the
    /// web has always polled at, and the phones' ITEM push rides the same tick.
    private let slowTickSeconds = 0.160

    // MARK: - Surface lifecycle

    /// Create the display on `layer`, or resize it if one already exists.
    ///
    /// Idempotent on purpose: `MetalSurfaceView` calls this from every layout
    /// pass, so the create/resize split is decided here rather than in the view.
    /// `size` is in PHYSICAL pixels and must already be the layer's
    /// `drawableSize` — Filament reports the layer's own size as the surface
    /// size, so the two disagreeing means the renderer's targets are the wrong
    /// shape for the thing they are presented into.
    func attach(layer: CAMetalLayer, size: CGSize, scale: CGFloat) {
        guard !isAttached else {
            // An output-mode switch moves the panel's scale under a live display;
            // `resize` -> `applyResize` re-derives `uiScale` from the new buffer,
            // so nothing is assigned here. Assigning the PANEL's scale was the
            // HUD-placement bug (see adoptSurface).
            resize(size: size)
            return
        }
        let w = pixelCount(size.width), h = pixelCount(size.height)
        // `Unmanaged.passUnretained(...).toOpaque()` is the whole cast: the ABI
        // takes an opaque `const void*` surface, and the .mm side `__bridge`s it
        // straight back to a `CAMetalLayer*` and class-checks it. The view owns
        // the layer and outlives the display, so nothing here has to be
        // retained — and there is no reinterpret to `UnsafePointer<CChar>`,
        // which is what this call had to spell while the ABI typed its surface
        // as the web's selector.
        guard ttp_display_create(Unmanaged.passUnretained(layer).toOpaque(), w, h) != 0 else {
            lastError = "ttp_display_create failed (\(w)x\(h))"
            return
        }
        isAttached = true
        adoptSurface(size, fallback: scale)
        flushPendingAssets()
        // Re-push every latched value that arrived before the surface existed.
        // The ABI is a safe no-op with no display (ttp_abi.h), which cuts both
        // ways: a pre-attach `setCells`/`bind` was silently dropped in C++
        // while the latch here recorded it delivered, so nothing ever retried —
        // and a scenario standing a race up at boot rendered a boundless,
        // cell-less overview forever. Same rule as `pendingAssets`, same
        // reason.
        if !lastCellsJSON.isEmpty { ttp_display_cells(lastCellsJSON) }
        if boundSession != 0 { ttp_display_bind(boundSession) }
        if lastCardMask != 0 { ttp_display_cell_cards(lastCardMask) }
        if let mode = lastCamMode { ttp_display_camera(mode) }
    }

    /// Tell the renderer the surface changed size. The caller sets
    /// `layer.drawableSize` first (the view does).
    ///
    /// **Between frames, never inside one.** `TtpRenderer::resize` does
    /// `destroySceneTarget(); ensureSceneTarget();`, and the first of those
    /// calls `flushAndWait()` — which on Metal blocks on the driver thread. A
    /// resize asked for from inside the frame callback is deferred to the top of
    /// the next tick rather than run there.
    func resize(size: CGSize) {
        guard isAttached else { return }
        // Latched on the size, not just called politely. `MetalSurfaceView` syncs
        // from every layout pass, and a layout pass is not a resize: without this
        // every SwiftUI update that touches the hierarchy would rebuild the
        // renderer's targets and block on `flushAndWait`.
        guard size != surfacePixels else { return }
        guard !inFrame else { pendingSize = size; return }
        applyResize(size)
    }

    private func applyResize(_ size: CGSize) {
        adoptSurface(size)
        ttp_display_resize(pixelCount(size.width), pixelCount(size.height))
        // A new buffer size is a different thing to measure, and the readout
        // carries the size it was measured at — so the window goes with it
        // (ttp_perf.h). Without this an output-mode switch leaves 4K frames
        // folded into a 1080p reading for the next two seconds.
        // AND THIS IS THE ONE THAT MATTERS TO THE SCALE, not the drop the rule
        // already took when it decided. `TtpRenderer::resize` destroys the scene
        // target, which `flushAndWait`s and blocks, so the resize ITSELF produces
        // one very late present. Left in the window it lands in the frames that
        // decide the NEXT step: the rule reads it as the box still being late and
        // steps down again, each step stalling again. Measured as a visible
        // cascade down the ladder in a solo race, which is the whole of "it hangs
        // and keeps dropping resolution".
        perf.reset()
        // The resize reallocated (and cleared) the render targets. A running
        // loop repaints on the next tick; a loop that has not started yet would
        // hold a blank surface, so repaint once — `dt` 0 re-presents the last
        // frame unchanged. Same fix, same reason, as `Stage.js`'s `_onResize`.
        if link == nil { _ = ttp_display_frame(0) }
    }

    /// Take a new buffer size, and DERIVE the chrome's scale from it.
    ///
    /// **`uiScale` is buffer pixels per POINT, and it is not the panel's scale.**
    /// The two agree only while the buffer is the panel's own resolution, and the
    /// adaptive render scale is exactly the thing that makes them differ.
    /// `cellRects` divides by this, so a stale value puts every chrome element at
    /// `renderScale` of its correct position — the HUD walking in from the corner,
    /// which is what a stored copy of `nativeScale` did the first time this
    /// shipped. Its own doc had predicted it: "a different one is exactly how
    /// every label ends up at 1/scale of its cell."
    ///
    /// DERIVED from the two numbers that define it rather than tracked beside
    /// them, so there is nothing to keep in sync. The passed scale is the fallback
    /// for the one moment the view has no box yet — before the first layout, where
    /// `surfacePixels(scale:)` seeds from the screen for the same reason.
    private func adoptSurface(_ size: CGSize, fallback: CGFloat? = nil) {
        surfacePixels = size
        let boxHeight = surface.bounds.height
        if boxHeight > 0, size.height > 0 {
            uiScale = size.height / boxHeight
        } else if let fallback {
            uiScale = fallback
        }
    }

    private func pixelCount(_ v: CGFloat) -> UInt32 {
        UInt32(max(1, min(v.rounded(), CGFloat(UInt32.max))))
    }

    // MARK: - The frame loop

    func start() {
        guard link == nil else { return }
        let proxy = LinkProxy(host: self)
        let l = CADisplayLink(target: proxy, selector: #selector(LinkProxy.step(_:)))
        // `preferredFramesPerSecond` is deliberately left at the system default.
        // DO NOT ASK FOR 60: the spike's device round found this exact box
        // driving the TV at 50 Hz in PAL match mode, and a shell that names a
        // rate the panel cannot present just drops every sixth frame.
        //
        // `.common` rather than `.default`, so the loop keeps running while the
        // tvOS focus engine is animating.
        l.add(to: .main, forMode: .common)
        link = l
        linkProxy = proxy
        lastTimestamp = 0
        lastSlowTick = CACurrentMediaTime()
    }

    /// Idle the frame loop while the app is not on screen, and wake it when it
    /// is back.
    ///
    /// **A BACKGROUNDED APP MUST NOT DRIVE METAL**, and this shell did: the link
    /// was started once and ran for the life of the process, straight through
    /// every Menu press. What that cost is a permanently dead surface — Filament's
    /// `beginFrame` paces on a fence from two frames back, the frame in flight
    /// when tvOS took the screen away never completes, and the skipper then
    /// refuses EVERY frame for the rest of the process. Photographed on the
    /// device it reads `0/60 fps, 60 skips`: the link ticking normally, nothing
    /// reaching the panel, and no recovery — starting a race does not help,
    /// because nothing renders again at all.
    ///
    /// Paused rather than invalidated, so the link keeps its target and its
    /// `.common` mode registration; `lastTimestamp` is cleared on the way back so
    /// the first frame after a wake is handed one cadence rather than the whole
    /// time the app spent away.
    func setPaused(_ paused: Bool) {
        link?.isPaused = paused
        if !paused { lastTimestamp = 0 }
    }

    fileprivate func step(_ link: CADisplayLink) {
        inFrame = true
        defer { inFrame = false }

        // A resize that arrived mid-frame, applied where it is safe: at the top
        // of a tick, with no frame in flight. The render scale's own move takes
        // the same seat and OUTRANKS a pending layout size, because it recomputes
        // from the view's current box: honouring both would resize twice in one
        // tick to land on the number the second one already carried.
        if pendingScaleMove {
            pendingScaleMove = false
            pendingSize = nil
            applyResize(surface.resyncDrawable())
        } else if let size = pendingSize {
            pendingSize = nil
            applyResize(size)
        }

        // `targetTimestamp - timestamp` is this display's real cadence (0.02 on
        // a 50 Hz TV), and it is the honest answer for the first tick, which
        // nothing precedes. After that the dt is the ELAPSED time between
        // presents, because a dropped vsync must not slow the RACE down: the
        // cadence would report one interval while two went by, and the sim this
        // dt feeds is what the phones are steering.
        let cadence = link.targetTimestamp - link.timestamp
        let elapsed = lastTimestamp > 0 ? link.timestamp - lastTimestamp : cadence
        lastTimestamp = link.timestamp
        let dt = min(max(elapsed, 0), maxFrameSeconds)
        declarePacing(link)

        onFrame?(dt)

        // Quantised to frame boundaries, exactly like the web's guard: the first
        // frame whose elapsed time EXCEEDS the window. "~6 Hz" is a consequence
        // of that, not a target — at 50 Hz it slips to 180 ms, and nothing here
        // depends on the difference.
        if link.timestamp - lastSlowTick > slowTickSeconds {
            lastSlowTick = link.timestamp
            onSlowTick?()
        }

        // 0 IS A LEGITIMATE FRAME SKIP, not an error. Off emscripten the
        // renderer keeps Filament's pacing verdict: `beginFrame` returning false
        // means the surface still holds a frame the compositor has not shown.
        // The web ignores it because rAF already paces. A shell that logs,
        // retries or reinitialises on 0 will thrash.
        //
        // It is also the ONLY thing here that knows what the television showed.
        // The link ticks at the panel's rate whether or not a frame was drawn,
        // so a readout counting ticks reads a flat 60 straight through a skip
        // storm — the failure `TtpRendererFrame.cpp`'s pacing note describes for
        // rAF, arrived at by a different road. Hence the verdict goes to the
        // monitor rather than the floor.
        let presented = ttp_display_frame(dt) != 0

        // The first painted frame OF A BUILT SCENE, which is what the backdrop
        // waits on. Both halves matter: a present with no scene is the renderer
        // clearing an empty view, and revealing that is the same black flash as
        // revealing nothing at all.
        if presented && hasScene && !hasPainted {
            hasPainted = true
            onFirstPaint?()
        }

        perf.record(now: link.timestamp, interval: elapsed, presented: presented,
                    cells: cellCount, pixels: surfacePixels, dpr: uiScale)

        adaptScale(link)
    }

    /// Ask for the operating point, and arm the move.
    ///
    /// EVERYTHING HERE IS A FACT ABOUT THIS SURFACE. The two that look like
    /// choices are not: the ceiling is 1.0 because a television app has nothing
    /// to gain from supersampling its own panel, and the floor is 0 because THE
    /// LADDER OWNS THE FLOOR — a number here could only narrow the band, never
    /// reach below the bottom rung, and never mean a different picture than it
    /// does on the other two shells.
    ///
    /// THE RATE ARM IS UNREACHABLE HERE, and this notices rather than assumes
    /// it: both branches of the rule that may change a divisor sit inside its
    /// `gpuMs > 0` arm, and this platform has no usable GPU timer. If that ever
    /// stops being true the honest failure is a recorded complaint, not a shell
    /// that quietly performs half an answer — the pair is one decision, and
    /// honouring one half would be arbitrating the trade this shell is not
    /// entitled to make.
    private func adaptScale(_ link: CADisplayLink) {
        guard Self.scalePin == 0, isAttached else { return }
        var out = [Double](repeating: 0, count: 2)
        // `duration` — the panel's NOMINAL period, for the reason declarePacing
        // gives about the same number.
        let moved = ttp_display_scale_poll(link.timestamp * 1000,
                                           0, 1, surface.baseLines,
                                           link.duration * 1000, &out)
        guard moved != 0 else { return }
        // The divisor the readout is told about is `declarePacing`'s literal 1,
        // so an answer carrying anything else would put the rule and the overlay
        // on two different budgets.
        if out[1] != 1 {
            lastError = "ttp_display_scale_poll asked for divisor \(out[1]); tvOS presents every tick"
        }
        // WHAT THE RULE ANSWERED, and in RELEASE: a `racing` scenario logs no
        // readout at all, so without this there is no way to watch the scale
        // through a REAL race — which is exactly the path whose defects the bench
        // never showed. The numbers it was judged on are on the readout line.
        print(String(format: "[ttp] scale %.3f -> %.3f | panel %.1f ms",
                     renderScale, out[0], link.duration * 1000))
        renderScale = out[0]
        // ARMED HERE, PERFORMED AT THE TOP OF THE NEXT TICK. This runs from
        // inside the frame callback, and `TtpRenderer::resize` destroys the scene
        // target — which `flushAndWait`s, blocking on the Metal driver thread —
        // so the same deferral a mid-frame layout resize takes applies to this.
        pendingScaleMove = true
    }

    /// Tell the readout what this loop is AIMING AT: ONE VSYNC of this panel,
    /// and a divisor of 1.
    ///
    /// The period is a fact only the shell has, and undeclared the fold assumes
    /// 60 Hz — so the 50 Hz PAL match mode `start()` describes is scored against
    /// a budget the box can never meet and reads amber however idle it is. The
    /// divisor is 1 because nothing here presents on anything but every tick.
    /// `adaptScale` binds the RESOLUTION arm of `ttp_display_scale_poll`; the
    /// rate arm is unreachable rather than unbound, by the rule's construction —
    /// both branches that may move a divisor sit inside its `gpuMs > 0` arm, and
    /// this platform has no usable GPU term. `adaptScale` complains if an answer
    /// ever carries one anyway.
    ///
    /// `duration` AND NOT the `cadence` above, which is the wrong number for
    /// this question: `duration` is the panel's NOMINAL period and holds still
    /// through a stall, where the actual frame duration can come back a multiple
    /// of it — and a budget that grows every time the box struggles hides
    /// exactly the drops this is here to show. Undershooting is
    /// harmless in the other direction (the fold's bar never tightens past
    /// 60 Hz), so nominal is the safe end to be wrong on.
    ///
    /// Declared from the tick because that is the first moment the answer exists
    /// — `duration` is undefined until the link has fired — and re-declared when
    /// it MOVES, which is an output-mode switch.
    private func declarePacing(_ link: CADisplayLink) {
        let ms = link.duration * 1000
        guard ms > 0, ms != lastPanelMs else { return }
        lastPanelMs = ms
        ttp_perf_pacing(ms, 1)
    }

    // MARK: - Assets

    /// Hand the renderer a named asset's bytes (materials, GLBs, textures).
    ///
    /// Returns a plain Swift `Bool` rather than the ABI's int, so no call site
    /// has to spell a polarity at all — `ttp_display_asset` answers 1 for
    /// accepted, like every other int on this ABI.
    ///
    /// Lookups on the far side are exact-name (`mAssets.find(name)`): no path
    /// resolution, no extension inference, no fallback. A texture's name is
    /// literally the URI authored inside the GLB, e.g. `Textures/colormap.png`.
    @discardableResult
    func provideAsset(_ name: String, _ bytes: Data) -> Bool {
        guard isAttached else {
            pendingAssets.append((name, bytes))
            return true   // accepted, not yet provided — see `pendingAssets`
        }
        return TTP.withBytes(bytes) { ptr, len in ttp_display_asset(name, ptr, len) } != 0
    }

    /// `provideAsset`, throwing.
    ///
    /// The staging sequence wants a failure to STOP it rather than be counted:
    /// every `.filamat` blob but `vcolor` degrades SILENTLY when absent (no
    /// `vpresent` and the cells fall back to Filament's own post chain; no
    /// `voverlay` and the steer bar and cell dividers simply vanish), so a
    /// missing one has to be loud at the point it is missing. The web's
    /// `if (res.ok)` skip is exactly the pattern not to copy here.
    func provide(_ name: String, _ bytes: Data) throws {
        guard provideAsset(name, bytes) else { throw AssetFailure.rejected(name) }
    }

    enum AssetFailure: Error, CustomStringConvertible {
        case rejected(String)
        var description: String {
            switch self {
            case .rejected(let name): return "ttp_display_asset(\(name)) was rejected"
            }
        }
    }

    /// Told by the staging sequence once `ttp_display_build` has accepted.
    ///
    /// It exists because there is no ABI to ask "is a scene built": the builder
    /// is the only thing that knows, `hasScene` gates the race launch
    /// (`startInput`'s `sceneReady`), and the HUD maps its packed rows back onto
    /// players by the roster's SLOT ORDER, which is likewise established here and
    /// nowhere else.
    func sceneBuilt(rosterIds: [EngineIdentity], biome: String) {
        hasScene = true
        roster = rosterIds
        biomeName = biome
        // THE SCENE CLOCK THE SCALE RULE IS HANDED, stamped where a scene
        // actually becomes true. `SceneStaging` calls `ttp_display_build` itself
        // and then reports here; `build(trackId:rosterJSON:)` below has no
        // callers at all, so a hook there is stamped by nothing. Left unstamped
        // this reported the PROCESS UPTIME as the scene's age (30971 s into a
        // fresh race), which is a measurement the rule is entitled to trust.
        //
        // The window goes for the reason `applyResize` drops it: the lobby
        // attract and a race are different pictures, and a percentile that
        // straddles the two describes neither. The cost-model observation is
        // DROPPED rather than carried — a fit whose two points come from two
        // scenes measures a slope belonging to neither.
        perf.reset()
        ttp_display_scale_scene(CACurrentMediaTime() * 1000)
    }

    /// The biome the current scene RESOLVED to — the track's cup, or the
    /// override. Kept because the GO beat needs it by name
    /// (`ttp_race_start_beat_json` keys the music pool off it) and the staging
    /// sequence is the only thing that ever knew which one won.
    private(set) var biomeName = ""

    private func flushPendingAssets() {
        let queued = pendingAssets
        pendingAssets = []
        for (name, bytes) in queued {
            if !provideAsset(name, bytes) { lastError = "ttp_display_asset(\(name)) failed" }
        }
    }

    // MARK: - The scene

    /// Build the scene for `trackId`. `rosterJSON` is `[{id, name, carIndex,
    /// color}]` in SLOT order — the one thing about a race only the shell knows,
    /// since the sim's cars carry no livery and no display name.
    ///
    /// **PREDICATE polarity: 1 is success** (the outcome-style returns were
    /// retired with the polarity zoo). Returns whether a scene now exists. A
    /// failed build leaves `hasScene` false even in the one case where C++ kept
    /// the previous scene (an unknown trackId returns before releasing it):
    /// reporting "ready" there would let a race launch onto the last track's
    /// geometry.
    @discardableResult
    func build(trackId: String, rosterJSON: String) -> Bool {
        // The window describes the scene that just went away, exactly as it does
        // after a resize: the lobby attract and a race are different pictures,
        // so a percentile that straddles a build describes neither. Same line,
        // same reason, in `Stage.js` and Android's `DisplayHost`.
        perf.reset()
        hasScene = ttp_display_build(trackId, rosterJSON) != 0
        if !hasScene { lastError = "ttp_display_build(\(trackId)) failed" }
        return hasScene
    }

    /// Tear the scene down; the engine, views, materials and provided assets
    /// live on, so the next build is cheap.
    func release() {
        ttp_display_release()
        hasScene = false
    }

    // MARK: - What to draw

    /// The session whose cars this display draws. 0 = none (an empty track,
    /// which is what the lobby's preview is before the attract race starts).
    /// Held so `attach` can re-push a bind that predated the surface.
    private var boundSession: Int32 = 0

    func bind(session: Int32) {
        boundSession = session
        ttp_display_bind(session)
    }

    /// The cars that own a split-screen cell, in cell order. Everything else in
    /// the field is still drawn, it just has no camera; an empty list means the
    /// single overview camera fills the surface.
    func setCells(_ ids: [EngineIdentity]) {
        // Hand-joined rather than run through `TTP.json`, because an identity is
        // a JSON SCALAR: re-encoding a seat through `JSONSerialization` would
        // turn the number 3 into the string "3", and those are two different
        // players to `ttp::parse_scalar_id`.
        let json = "[" + ids.map(\.json).joined(separator: ",") + "]"
        cellCount = ids.count
        // Latched: which cars own cells changes on a seat edit, not per frame.
        guard json != lastCellsJSON else { return }
        lastCellsJSON = json
        ttp_display_cells(json)
    }

    /// The last camera mode asked for, so `attach` can re-push one that predated
    /// the surface. See `camera(_:)` — of everything the shell pushes, this is
    /// the only ONE-SHOT, which is why losing it is permanent.
    private var lastCamMode: Int32?

    /// Camera mode for a surface with no cells. Takes the ABI's own
    /// `TTP_CAM_STILL` / `_ORBIT` / `_BBOX` / `_FREE` rather than a Swift enum
    /// mirroring them, because a mirror is a second table nothing pins.
    ///
    /// LATCHED, for exactly the reason `setCells` and `bind` are: pushed with no
    /// display the ABI is a safe no-op, so a pre-attach call is dropped in C++
    /// while the caller believes it landed. The others are re-pushed on every
    /// roster edit and so repair themselves; this one is pushed ONCE, by
    /// `boot()`, whose async work races SwiftUI's first layout pass — win that
    /// race and the mode is gone for the life of the app, leaving the ABI
    /// default `TTP_CAM_STILL`: the fitted iso overview HELD MOTIONLESS, which
    /// reads as a correct render of a track rather than as a bug.
    func camera(_ mode: Int32) {
        lastCamMode = mode
        ttp_display_camera(mode)
    }

    /// Which cells have a centred card over them — bit i for cell i, in the
    /// order `setCells` named. A set bit hides that cell's steer bar, which is
    /// what the player who FINISHED or dropped should see: they are not
    /// steering, and the card is the cell's message.
    ///
    /// **Push this before the frame draws.** A mask that lands afterwards leaves
    /// the bar visible under a fresh card for one frame. Calling it from
    /// `onSlowTick` or `onFrame` is inside that guarantee.
    func cellCards(mask: UInt32) {
        guard mask != lastCardMask else { return }
        lastCardMask = mask
        ttp_display_cell_cards(mask)
    }

    /// Hold the field where it is, at rest. Two callers, both cases where the
    /// engine's live state is not what should be on screen: the pause overlay,
    /// and the end-of-race fast-forward (which runs the deterministic sim to the
    /// flag with no rendering, so the just-finished human's chase camera would
    /// otherwise be seen whipping across the track).
    func hold(_ held: Bool) { ttp_display_hold(held ? 1 : 0) }

    /// A rocket detonation, drawn on the next frame. The renderer cannot infer
    /// it: a rocket that HIT a car detonates ON that car and rides it out, while
    /// a whiff self-destructs at a track point. `id` nil is the whiff.
    func burst(id: EngineIdentity?, s: Double, lat: Double) {
        ttp_display_burst(id?.json, s, lat)
    }

    // MARK: - Readback

    /// Where the split-screen cells are, in POINTS, top-left origin, in cell
    /// order — the renderer's OWN split, read back rather than scored a second
    /// time here.
    ///
    /// **These are the LETTERBOXED rects** (`cellRectTopLeft`, capped at
    /// `CELL_MAX_ASPECT` and centred as one piece), not a raw tiling of the
    /// surface. Place all chrome from them and it cannot disagree with where the
    /// camera rendered; place it from anything else — a grid computed here, the
    /// view's own bounds divided by the cell count — and it lands where the
    /// picture is not. (The renderer's own steer bar drew off the raw grid until
    /// 2026-07-29: every bar sat a fifth of a cell off, under a car that was not
    /// there, and the 2-player STACKED layout is past the cap in ordinary play.)
    ///
    /// The ABI answers FRACTIONS of the surface, so these are multiplied by the
    /// view's own size in POINTS — never by anything the adaptive render scale
    /// moves. `uiScale` used to divide here, and a stale one put the whole HUD
    /// at 3/4 of its right place with nothing in the suite able to see it; there
    /// is no second value left to go stale.
    func cellRects(count: Int) -> [CGRect] {
        guard count > 0 else { return [] }
        // The VIEW's own bounds, which are points and do not move with the
        // buffer — `adoptSurface` reads the same `surface.bounds` to derive
        // `uiScale` for the readout.
        let vw = surface.bounds.width
        let vh = surface.bounds.height
        guard vw > 0, vh > 0 else { return [] }
        var packed = [Float](repeating: 0, count: count * 4)
        let got = packed.withUnsafeMutableBufferPointer { buf in
            Int(ttp_display_cell_rects(buf.baseAddress, Int32(count)))
        }
        // Spelled out with explicit types and a plain loop: the same expression
        // written as a `map` of four divisions is past the type checker's budget
        // and fails to compile with "unable to type-check in reasonable time".
        let n: Int = max(0, min(got, count))
        var rects: [CGRect] = []
        rects.reserveCapacity(n)
        for i in 0..<n {
            let x = CGFloat(packed[i * 4 + 0]) * vw
            let y = CGFloat(packed[i * 4 + 1]) * vh
            let w = CGFloat(packed[i * 4 + 2]) * vw
            let h = CGFloat(packed[i * 4 + 3]) * vh
            rects.append(CGRect(x: x, y: y, width: w, height: h))
        }
        return rects
    }

    /// What the HUD says, per roster slot: the six values the shell used to pull
    /// out of `ttp_snapshot_json` by parsing an entire race state and discarding
    /// all of it but these.
    ///
    /// **A READ, not a frame.** Nothing in the HUD has changed per frame since
    /// the steer bar moved into the renderer, so this is polled from
    /// `onSlowTick`.
    ///
    /// Slots no live car claims are SKIPPED rather than returned as zeroes, so a
    /// Grand Prix swapping tracks underneath the HUD leaves each cell's chrome
    /// alone instead of painting it "0th, lap 0".
    func hud() -> [HudSlot] {
        guard let block = ttp_display_hud() else { return [] }
        let head = block.pointee
        // A version mismatch means a stale static library, not a bad frame. An
        // empty HUD and one recorded reason beats a crash six times a second.
        guard head.version == UInt32(TTP_HUD_BLOCK_VERSION) else {
            lastError = "HUD block v\(head.version), expected v\(TTP_HUD_BLOCK_VERSION)"
            return []
        }
        // Walk by the block's OWN `stride`, never by `MemoryLayout<TtpHudSlot>`:
        // the field is carried precisely so a reader survives a slot growing at
        // the end, and anything MOVING a field bumps the version above.
        let slotStride = Int(head.stride)
        // `ttp_hud_slots` is a static inline over the block pointer, so it is
        // nullable to Swift even though it never returns null for a block we
        // just checked. A zero-slot block is the legitimate empty case and is
        // already covered by the loop bound.
        guard let slots = ttp_hud_slots(block) else { return [] }
        let base = UnsafeRawPointer(slots)
        var out: [HudSlot] = []
        out.reserveCapacity(Int(head.slotCount))
        for i in 0..<Int(head.slotCount) {
            let s = base.load(fromByteOffset: i * slotStride, as: TtpHudSlot.self)
            guard s.flags & UInt32(TTP_HUD_SLOT_LIVE) != 0 else { continue }
            out.append(HudSlot(slot: i, raw: s))
        }
        return out
    }

    /// One roster slot's HUD values, as the packed block spells them. The C
    /// struct is the source (`ttp_hud.h`); this only names the fields a Swift
    /// caller wants and keeps the `finishTime` null distinction, because a car
    /// can be finished with no recorded time (a forfeit resolved at the flag)
    /// and the card prints an empty string for that rather than "0.0s".
    struct HudSlot: Identifiable {
        /// Index into the roster handed to `ttp_display_build`. There is no car
        /// id in the block: slot i is the car the shell itself named i.
        let slot: Int
        let place: Int
        let lap: Int
        let totalLaps: Int
        /// A `TTP_ITEM_*` CODE, not a string. `TTP_ITEM_NONE` while the slot is
        /// empty and once the car has finished.
        let item: Int32
        let flags: UInt32
        let finishTime: Double?

        var id: Int { slot }
        var finished: Bool { flags & UInt32(TTP_HUD_SLOT_FINISHED) != 0 }

        init(slot: Int, raw: TtpHudSlot) {
            self.slot = slot
            self.place = Int(raw.place)
            self.lap = Int(raw.lap)
            self.totalLaps = Int(raw.totalLaps)
            self.item = raw.item
            self.flags = raw.flags
            self.finishTime = raw.flags & UInt32(TTP_HUD_SLOT_TIMED) != 0 ? raw.finishTime : nil
        }
    }
}

/// `CADisplayLink` retains its target, so the link cannot be the host's own
/// selector without pinning the display alive forever. This holds the host
/// weakly and is thrown away with the link.
@MainActor
private final class LinkProxy: NSObject {
    weak var host: DisplayHost?
    init(host: DisplayHost) { self.host = host }
    @objc func step(_ link: CADisplayLink) { host?.step(link) }
}
