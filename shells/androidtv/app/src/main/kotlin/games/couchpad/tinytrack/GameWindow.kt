package games.couchpad.tinytrack

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.graphics.drawable.DrawableWrapper
import android.view.SurfaceView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.node.GlobalPositionAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import kotlin.math.ceil
import kotlin.math.floor

/*
 * THE WINDOW UNDER THE RACE CLEARS ONLY WHAT IT DREW.
 *
 * The window's own buffer sits over the engine's SurfaceView, and the name tags
 * redraw it on every presented frame. Each of those frames used to paint the
 * paper background and then have the SurfaceView punch its whole rect back to
 * transparent with destination-out: a full-window BLENDED pass on the GPU the
 * race shares. So while the surface is showing (DisplayHost says when, per
 * surface) and covers the whole window, the paper and the punch are skipped and
 * the window is cleared instead (docs/perf/androidtv-frame-map.md has what each
 * step bought). Otherwise the paper and the punch are exactly what the theme and
 * the stock SurfaceView draw.
 *
 * A whole-window clear is not free either: Skia's GL backend on this PowerVR
 * performs every clear as a DRAW (`fPerformColorClearsAsDraws`), a full window
 * of fill per window frame. Skipping it outright leaves trails, because HWUI
 * keeps the window's buffers between frames: a buffer comes back holding what
 * was drawn into it a few frames earlier. So [WindowErase] clears only the
 * rects those buffers can still hold — the name tags' recent positions and
 * the race HUD's retained sticker groups, which are redrawn over
 * themselves every frame and would darken at their anti-aliased edges if they
 * were not erased first. That is only sound while EVERYTHING in the window has
 * a tracked rect, so any other content ([UnboundedContent]) and any change to a
 * tracked bound drops back to the whole clear for [WindowErase.K] tag draws,
 * which purges every buffer in the queue before the rects take over again.
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
        WindowErase.covered = clear
        invalidate()
    }

    // A SurfaceView draws nothing of its own (SKIP_DRAW): its punch is all that
    // dispatchDraw does.
    override fun dispatchDraw(canvas: Canvas) {
        if (!windowClear) super.dispatchDraw(canvas)
    }
}

/** The window background: the theme's own paper drawable, or nothing ([WindowErase] clears). */
class WindowBackground(paper: Drawable) : DrawableWrapper(paper) {
    var showPaper = true
        set(value) {
            if (field == value) return
            field = value
            invalidateSelf()
        }

    override fun draw(canvas: Canvas) {
        if (showPaper) super.draw(canvas)
    }
}

/**
 * What a covered window clears each window frame, drawn by [NameTagView] before
 * anything else in the window: the tag view sits under the ComposeView and the
 * background draws nothing. Window pixels throughout, which are the tag view's
 * and the Compose root's, since a covered window has both at its origin.
 *
 * The unit is the tag view's RECORD, not the window frame: the clear lives in
 * the tag view's display list, which HWUI may replay in later window frames
 * (the HUD redrew, the tags did not) or sync and never draw (already drew this
 * vsync). A replay is why each record also clears its own tag rects; a record
 * that never reaches a buffer is why [K] has slack.
 */
object WindowErase {
    /**
     * The oldest record a buffer can come back holding. HWUI sizes the window's
     * queue at min-undequeued + 2 buffers, three or four here, and each record
     * HWUI skips drawing makes a buffer's content one record older; past [K] a
     * leftover is never erased again, so this keeps room for two such skips.
     */
    const val K = 6

    /** Device pixels around every rect: the edge a filtered or AA draw can touch. */
    const val MARGIN = 1

    /** Re-records the view that calls [clear] ([MainActivity] wires it). */
    var onChanged: (() -> Unit)? = null

    /** The surface is showing and covers the whole window ([GameSurfaceView]). */
    var covered = false
        set(value) {
            if (field == value) return
            field = value
            changed()
        }

    private var unbounded = 0
    /** The HUD groups' rects, each owned and kept current by its [ErasedBoundsNode]. */
    private val groups = ArrayList<Rect>()
    /** Whole clears in a row with all content tracked. */
    private var purged = 0
    /** The last [K] records' tag rects and this one's, `[record][tag][l, t, r, b]`. */
    private var past = IntArray(0)
    private var record = 0
    private val paint = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR) }

    /** Something in the window moved in a way the rects cannot cover. */
    fun changed() {
        purged = 0
        onChanged?.invoke()
    }

    /** Window content with no tracked bounds came (+1) or went (-1). */
    fun unbounded(delta: Int) {
        unbounded += delta
        changed()
    }

    /** A HUD group's rect joins, and is read in place: its owner calls [changed] when it moves. */
    fun attach(group: Rect) { groups.add(group) }

    /** A HUD group's rect leaves. By identity: two groups can share a value. */
    fun detach(group: Rect) {
        groups.removeAt(groups.indexOfFirst { it === group })
        changed()
    }

    /**
     * Clears what this record must. [tags] holds [n] of this record's tag rects
     * as `l, t, r, b`, which join the history whatever is drawn.
     */
    fun clear(canvas: Canvas, tags: IntArray, n: Int) {
        val cap = tags.size / 4
        if (past.size != (K + 1) * cap * 4) past = IntArray((K + 1) * cap * 4)
        // This record's tags replace the oldest record's.
        val base = record * cap * 4
        past.fill(0, base, base + cap * 4)
        for (o in 0 until n * 4 step 4) {
            past[base + o] = tags[o] - MARGIN
            past[base + o + 1] = tags[o + 1] - MARGIN
            past[base + o + 2] = tags[o + 2] + MARGIN
            past[base + o + 3] = tags[o + 3] + MARGIN
        }
        record = (record + 1) % (K + 1)
        if (covered && unbounded == 0 && purged >= K) {
            for (i in 0 until (K + 1) * cap) {
                val o = i * 4
                if (past[o + 2] > past[o]) {
                    canvas.drawRect(past[o].toFloat(), past[o + 1].toFloat(),
                        past[o + 2].toFloat(), past[o + 3].toFloat(), paint)
                }
            }
            for (i in groups.indices) canvas.drawRect(groups[i], paint)
        } else {
            // The paper, untracked content, or one of the K whole clears that
            // purge the queue: the count starts once the paper and the content
            // have gone.
            purged = if (covered && unbounded == 0) purged + 1 else 0
            if (covered) canvas.drawColor(0, PorterDuff.Mode.CLEAR)
        }
    }
}

/**
 * Marks window content [WindowErase] has no rect for: while one is composed, a
 * covered window clears whole. Every board, overlay and card that can share the
 * glass with the race calls it; the race HUD's retained groups do not
 * ([erasedBounds]), and neither do the name tags.
 */
@Composable
fun UnboundedContent() {
    DisposableEffect(Unit) {
        WindowErase.unbounded(+1)
        onDispose { WindowErase.unbounded(-1) }
    }
}

/**
 * Hands this node's bounds to [WindowErase] while it is attached. Placed right
 * after a retained layer, so the bounds are the whole layer, padding included.
 * Unclipped: the padding hangs outside the parent on purpose.
 */
fun Modifier.erasedBounds(): Modifier = this then ErasedBoundsElement

private object ErasedBoundsElement : ModifierNodeElement<ErasedBoundsNode>() {
    override fun create() = ErasedBoundsNode()
    override fun update(node: ErasedBoundsNode) {}
    override fun hashCode() = 0
    override fun equals(other: Any?) = other === this
}

private class ErasedBoundsNode : Modifier.Node(), GlobalPositionAwareModifierNode {
    private val rect = Rect()
    private var placed = false

    override fun onGloballyPositioned(coordinates: LayoutCoordinates) {
        val box = coordinates.findRootCoordinates().localBoundingBoxOf(coordinates, clipBounds = false)
        val l = floor(box.left).toInt() - WindowErase.MARGIN
        val t = floor(box.top).toInt() - WindowErase.MARGIN
        val r = ceil(box.right).toInt() + WindowErase.MARGIN
        val b = ceil(box.bottom).toInt() + WindowErase.MARGIN
        if (placed && rect.left == l && rect.top == t && rect.right == r && rect.bottom == b) return
        rect.set(l, t, r, b)
        if (!placed) WindowErase.attach(rect)
        placed = true
        WindowErase.changed()
    }

    override fun onDetach() {
        if (placed) WindowErase.detach(rect)
        placed = false
    }
}
