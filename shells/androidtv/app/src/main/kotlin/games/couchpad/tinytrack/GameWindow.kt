package games.couchpad.tinytrack

import android.content.Context
import android.graphics.Canvas
import android.graphics.PorterDuff
import android.graphics.drawable.Drawable
import android.graphics.drawable.DrawableWrapper
import android.view.SurfaceView

/*
 * THE WINDOW UNDER THE RACE DRAWS NOTHING ONCE THE SURFACE IS SHOWING.
 *
 * The window's own buffer sits over the engine's SurfaceView, and the name tags
 * redraw it on every presented frame. Each of those frames used to paint the
 * paper background and then have the SurfaceView punch its whole rect back to
 * transparent with destination-out: a full-window BLENDED pass on the GPU the
 * race shares. A CLEAR of the background leaves the same zero bytes without the
 * blend (docs/perf/androidtv-frame-map.md has what it bought). So while the
 * surface is showing (DisplayHost says when, per surface) and covers the whole
 * window, the background clears and the punch is skipped. Otherwise the paper
 * and the punch are exactly what the theme and the stock SurfaceView draw.
 */

/** The engine's SurfaceView, which decides whether the window under it paints. */
class GameSurfaceView(
    context: Context,
    private val background: WindowBackground,
) : SurfaceView(context) {
    private var showing = false
    private var windowClear = false
    private val origin = IntArray(2)

    init {
        // A layout change can end the coverage while the surface keeps showing.
        addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateWindow() }
    }

    /** Whether the current surface is showing ([DisplayHost.onSurfaceShowing]). */
    fun setShowing(showing: Boolean) {
        this.showing = showing
        updateWindow()
    }

    private fun updateWindow() {
        // Only a surface that covers the whole window may stand in for it: a
        // cleared window shows black wherever the surface does not reach.
        getLocationInWindow(origin)
        val clear = showing && origin[0] == 0 && origin[1] == 0
                && width == rootView.width && height == rootView.height
        if (clear == windowClear) return
        windowClear = clear
        background.showPaper = !clear
        invalidate()
    }

    // A SurfaceView draws nothing of its own (SKIP_DRAW): its punch is all that
    // dispatchDraw does.
    override fun dispatchDraw(canvas: Canvas) {
        if (!windowClear) super.dispatchDraw(canvas)
    }
}

/** The window background: the theme's own paper drawable, or a clear. */
class WindowBackground(paper: Drawable) : DrawableWrapper(paper) {
    var showPaper = true
        set(value) {
            if (field == value) return
            field = value
            invalidateSelf()
        }

    override fun draw(canvas: Canvas) {
        if (showPaper) super.draw(canvas) else canvas.drawColor(0, PorterDuff.Mode.CLEAR)
    }
}
