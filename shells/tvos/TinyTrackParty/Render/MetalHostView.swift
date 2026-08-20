import Metal        // MTLPixelFormat — CAMetalLayer's `pixelFormat` is one
import QuartzCore
import SwiftUI
import UIKit

/// The Metal surface Filament renders into, and nothing else.
///
/// This is the tvOS counterpart of the web shell's `<canvas>` (`Stage.js`'s
/// `_canvas`): a rectangle the C++ renderer owns for the life of the process,
/// with every piece of chrome floating above it as a sibling. It draws nothing
/// itself, holds no game state and knows no rule — its whole job is to keep the
/// layer's pixel format and drawable size honest and to tell `DisplayHost` when
/// either moves.
///
/// It is NOT owned by SwiftUI. `DisplayHost` holds the instance and
/// `MetalHostView` (the representable below) hands the same one back on every
/// `makeUIView`, because Filament takes this layer as its native window when the
/// swap chain is made: a view SwiftUI felt free to recreate would leave the
/// engine drawing into a layer that is no longer on screen.
final class MetalSurfaceView: UIView {

    /// The layer IS the surface. `ttp_display_create` takes it straight across
    /// as an opaque `const void*`, and Filament's `MetalSwapChain` asserts that
    /// its native window `isKindOfClass:[CAMetalLayer class]`.
    override class var layerClass: AnyClass { CAMetalLayer.self }

    var metalLayer: CAMetalLayer { layer as! CAMetalLayer }

    /// Weak: the host owns this view, so an owning reference back would be a
    /// cycle that keeps the Filament engine alive past teardown.
    private weak var host: DisplayHost?

    init(host: DisplayHost) {
        self.host = host
        super.init(frame: .zero)

        // The renderer fills every pixel of its own surface; nothing behind this
        // view is ever meant to show through it.
        isUserInteractionEnabled = false

        let l = metalLayer
        // BGRA8Unorm, and NOT the _sRGB variant. This single line is the
        // difference between the shipped look and a picture that is graded
        // twice: `vpresent.mat` writes an ALREADY sRGB-encoded value (it grades,
        // encodes, then FXAAs) and `voverlay.mat` states outright that what it
        // writes IS the on-panel sRGB value. An `_sRGB` layer would encode the
        // whole frame a second time, and the symptom reads as a colour-grading
        // bug somewhere in the renderer rather than as one property on a layer.
        l.pixelFormat = .bgra8Unorm
        // Seeded from the screen because a view that has never laid out has no
        // box of its own yet, and the surface has to be valid before
        // `ttp_display_create` sees it. `layoutSubviews` takes over below.
        l.drawableSize = UIScreen.main.nativeBounds.size
        contentScaleFactor = UIScreen.main.nativeScale
        // `device` and `framebufferOnly` are deliberately NOT set here: Filament
        // sets both when it creates the swap chain, and a shell that sets them
        // first is guessing at the engine's requirements.

        // The TV's output resolution being switched at runtime (and AirPlay/
        // mirroring) moves `nativeScale` and `nativeBounds` under a view whose
        // bounds in POINTS never change — tvOS is 1920x1080 points in both
        // output modes — so layout alone never hears about it. The scale trait
        // does. (The deployment floor is tvOS 17, so the registration API is
        // always there; `traitCollectionDidChange` is its deprecated spelling.)
        registerForTraitChanges([UITraitDisplayScale.self]) { (view: MetalSurfaceView, _: UITraitCollection) in
            view.syncSurface()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("MetalSurfaceView is created in code, by DisplayHost") }

    // MARK: - Resize

    // Two hooks, because the surface moves for two different reasons: layout
    // covers the view's own box changing, and the scale-trait registration in
    // `init` covers the output-mode switch.

    override func layoutSubviews() {
        super.layoutSubviews()
        syncSurface()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // The window is where the real screen comes from (see `screen` below),
        // so the first sync that can know the true scale is this one.
        syncSurface()
    }

    /// The screen this view is actually on. `UIScreen.main` is the seed rather
    /// than the answer: before the view is in a window there is no context to
    /// ask, and on tvOS the two agree anyway.
    private var screen: UIScreen { window?.screen ?? UIScreen.main }

    /// The drawable's size in PHYSICAL pixels — the units `ttp_display_create`,
    /// `ttp_display_resize` and `ttp_display_cell_rects` all speak.
    ///
    /// Derived from the VIEW's box rather than the screen's, even though the
    /// ledger quotes `nativeBounds`: the two are the same number while this view
    /// is full screen (which it is), but a drawable larger than the layer it
    /// composites into would be scaled down by Core Animation, and every cell
    /// rect would then describe a picture that is not where the chrome is.
    ///
    /// **HEIGHT FIRST, width derived from the box's aspect**, because the
    /// adaptive rung is a LINE COUNT (`kScaleLadder`). Rounding the two axes
    /// independently lets a scale land off-grid — 0.75 of 3840x2160 rounded per
    /// axis is 2880x1620 either way, but a rung whose factor does not divide
    /// cleanly would not be, and 1620 lines IS 2880 wide. Same derivation, same
    /// reason, as Android's `applyScale`.
    private func surfacePixels(scale: CGFloat) -> CGSize {
        let box = bounds.size
        guard box.width > 0, box.height > 0 else { return screen.nativeBounds.size }
        let k = CGFloat(host?.renderScale ?? 1.0)
        let h = max(1, (box.height * scale * k).rounded())
        return CGSize(width: max(1, (h * box.width / box.height).rounded()), height: h)
    }

    /// Buffer lines a scale of 1.0 means on this surface — `ttp_display_step`'s
    /// `baseLines`, and the number its LINE-COUNT rungs are resolved against.
    /// The panel's own height, never the current buffer's: the whole point is
    /// what a scale of 1 would buy.
    var baseLines: Double {
        let box = bounds.size
        guard box.height > 0 else { return Double(screen.nativeBounds.height) }
        return Double((box.height * screen.nativeScale).rounded())
    }

    /// Re-point the drawable after `DisplayHost.renderScale` moved, and hand
    /// back the new size. The view stays the ONE owner of the buffer size — a
    /// host that computed one itself would be a second owner, and the two would
    /// disagree on the first layout pass.
    ///
    /// It does NOT call `attach`, which is the difference from `syncSurface`:
    /// the caller is the frame loop at the top of a tick, where it may resize the
    /// renderer directly because it knows no frame is in flight. Going through
    /// `attach` would take `resize`'s mid-frame deferral and land the buffer a
    /// tick before the targets that have to match it.
    @discardableResult
    func resyncDrawable() -> CGSize {
        let size = surfacePixels(scale: screen.nativeScale)
        if metalLayer.drawableSize != size { metalLayer.drawableSize = size }
        return size
    }

    private func syncSurface() {
        let scale = screen.nativeScale
        contentScaleFactor = scale
        let size = surfacePixels(scale: scale)
        // drawableSize FIRST, then the host. Filament reads `layer.drawableSize`
        // live on every surface-size query, so this property IS the resize as
        // far as the backend is concerned and the swap chain is never recreated;
        // the host's half only re-makes the renderer's own targets, and it has
        // to be told about a surface that already has the new size.
        if metalLayer.drawableSize != size { metalLayer.drawableSize = size }
        // Idempotent: the first call creates the display, every later one is a
        // resize (plus a UI-scale re-push, which is what an output-mode switch
        // between 1080p and 4K actually needs).
        host?.attach(layer: metalLayer, size: size, scale: scale)
    }
}

/// The SwiftUI face of the surface. Put it at the bottom of the screen's ZStack
/// and float the chrome over it, exactly as `index.html` does with the canvas.
///
///     MetalHostView(host: game.display)
///
struct MetalHostView: UIViewRepresentable {
    let host: DisplayHost

    /// The host's own view, never a fresh one. See `MetalSurfaceView`'s note on
    /// why SwiftUI may not own this object's lifetime.
    func makeUIView(context: Context) -> MetalSurfaceView { host.surface }

    /// Nothing here is a function of SwiftUI state. The surface's only inputs
    /// are its size and the screen's scale, both of which arrive through UIKit
    /// layout, and the frame loop is the host's.
    func updateUIView(_ uiView: MetalSurfaceView, context: Context) {}

    // No `dismantleUIView`: a view-tree rebuild must NOT tear the display down.
    // Nothing calls `ttp_display_destroy` on this platform at all — the display
    // lives for the process, and the process going away is the teardown.
}
