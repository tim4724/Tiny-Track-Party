package games.paperballoon.tinytrack

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View
import androidx.compose.ui.graphics.toArgb
import kotlin.math.ceil

/**
 * The name tags over every other player's car in each cell: the Android half
 * of the web's `Stage._paintNameTags` and its `.name-tag` CSS, and the twin of
 * tvOS's `NameTags.swift`, method for method.
 *
 * **THE ONE HUD ELEMENT PLACED PER FRAME, AND WHY IT IS NOT COMPOSE.** A tag
 * rides a moving car, so it moves on every presented frame, and Compose shares
 * this thread with the renderer: a recomposition that reaches layout costs tens
 * of ms on the box (`shells/androidtv/CLAUDE.md`). This is a plain View for the
 * reason [PerfOverlayView] is one. WHERE each tag goes is C++'s
 * (`ttp_display_name_tags`, read by [DisplayHost] right after the frame it
 * describes); this decides nothing.
 *
 * **A TAG IS DRAWN ONCE, NOT PER FRAME.** Each car's tag (a livery pill with its
 * tail, white Fredoka) is rasterized into a Bitmap when its name or colour
 * changes, and a frame only draws those bitmaps through a matrix. No text is
 * shaped and nothing is allocated on the frame path.
 *
 * Sits UNDER the ComposeView, so the cell chips and cards paint over a tag that
 * drifts beneath them, as on the web.
 *
 * **WHAT IT COSTS.** Anything in the app window that changes every frame makes
 * HWUI render a window frame every vsync on the same GPU as the race. That
 * used to be visible in a 4-cell worst second; since the window clears only
 * what it drew (GameWindow.kt) and the race HUD's groups are retained, the
 * tags on or off measure the SAME race (docs/perf/androidtv-frame-map.md,
 * 2026-10-14: 605 vs 24 window frames per 10 s, no change in GPU time or
 * skips). The tags move on EVERY presented frame (user decision: a tag
 * updating at a different rate from the car under it reads as broken).
 * Measured and rejected as no cheaper or worse: one child View per tag (a
 * window frame at all is the cost, not its size), a translucent SurfaceView
 * of its own (this box's composer overlays only two app layers — a third
 * sends it AND the window to GPU composition, re-measured 2026-10-14), and
 * drawing the tags inside the Filament frame at native resolution (the
 * full-size present alone costs more than the whole window).
 * `debug.ttp.tags 0` ([PerfDebug]) turns them off for the A/B.
 */
class NameTagView(context: Context, maxPlayers: Int) : View(context) {

    /** A sticker: its box is [boxW] x [boxH], its bottom edge [lift] above the anchor. */
    private class TagBitmap(val name: String, val color: Int, val bitmap: Bitmap,
                          val boxW: Float, val boxH: Float, val lift: Float) {
        val anchorX get() = boxW / 2
        val anchorY get() = boxH + lift
    }

    /**
     * The most tags a frame can hold: one cell per player, each naming every
     * other player. `maxPlayers` is the protocol manifest's MAX_PLAYERS.
     */
    val maxTags = maxPlayers * (maxPlayers - 1)

    /** C++ writes into this directly ([DisplayHost]); [count] says how much of it is live. */
    val tags = FloatArray(maxTags * TAG_STRIDE)
    private var count = 0

    /** Slot i's car id, latched per scene build by [DisplayHost]. */
    private var slots: List<EngineId> = emptyList()
    private var stickers = HashMap<EngineId, TagBitmap>()
    /** The slots' sticker sizes have moved since C++ was last told ([reportSizes]). */
    private var sizesDirty = true

    /** Authored pixels (1920 wide) to this window's physical pixels. */
    private val k = resources.displayMetrics.widthPixels / AUTHORED_WIDTH
    private val face = Typeface.createFromAsset(context.assets, "fonts/Fredoka-SemiBold.ttf")
    private val matrix = Matrix()
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    /** This frame's tag rects for [WindowErase], `l, t, r, b` each. */
    private val rects = IntArray(maxTags * 4)
    /** This frame's sticker per tag, looked up once for both passes. */
    private val found = arrayOfNulls<TagBitmap>(maxTags)
    private val box = RectF()
    private val rounded = Rect()

    init {
        isFocusable = false
        setWillNotDraw(false)
    }

    /**
     * Who the field is: re-rasterizes only the stickers whose name or livery
     * moved, and drops the ones whose car left. Called whenever the scene's cars
     * change (a build, a rename), never per frame. Only a car with a cell can be
     * named, so a CPU car gets no sticker.
     */
    fun setField(cars: List<SceneCar>) {
        val next = HashMap<EngineId, TagBitmap>(cars.size * 2)
        for (car in cars) {
            if (!car.cell) continue
            val color = Tokens.car(car.colorIndex).toArgb()
            val have = stickers[car.id]
            next[car.id] = if (have != null && have.name == car.name && have.color == color) have
                else rasterize(car.name, color)
        }
        stickers = next
        sizesDirty = true
        invalidate()
    }

    /** The scene's slot order, off the built roster (`ttp_display_slot_ids_json`). */
    fun setSlots(ids: List<EngineId>) { slots = ids; sizesDirty = true }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        sizesDirty = true
        // A resized window gets new buffers, and nothing in them is tracked.
        WindowErase.changed()
    }

    /**
     * Hands each slot's sticker box to [report] as fractions of this view — the
     * size C++ measures a tag's cover against (`ttp_display_name_tag_size`) —
     * but only when a sticker, the slot order or the view moved. [DisplayHost]
     * makes the call, since nothing else here touches the ABI.
     */
    fun reportSizes(report: (slot: Int, w: Float, h: Float, lift: Float) -> Unit) {
        if (!sizesDirty || width == 0 || height == 0) return
        sizesDirty = false
        val w = width.toFloat()
        val h = height.toFloat()
        slots.forEachIndexed { slot, id ->
            val s = stickers[id] ?: return@forEachIndexed
            report(slot, s.boxW / w, s.boxH / h, s.lift / h)
        }
    }

    /** How many tags C++ just wrote into [tags]; 0 hides them all. */
    fun show(n: Int) {
        if (n == 0 && count == 0) return
        count = n
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        // Every tag's window rect first: the window clears under the tags before
        // any of them draws (GameWindow.kt).
        var n = 0
        for (i in 0 until count) {
            val s = slots.getOrNull(tags[i * TAG_STRIDE + 1].toInt())?.let { stickers[it] }
            found[i] = s
            if (s == null) continue
            place(i, s)
            box.set(0f, 0f, s.bitmap.width.toFloat(), s.bitmap.height.toFloat())
            matrix.mapRect(box)
            box.roundOut(rounded)
            rects[n * 4] = rounded.left
            rects[n * 4 + 1] = rounded.top
            rects[n * 4 + 2] = rounded.right
            rects[n * 4 + 3] = rounded.bottom
            n++
        }
        WindowErase.clear(canvas, rects, n)
        for (i in 0 until count) {
            val s = found[i] ?: continue
            place(i, s)
            paint.alpha = (tags[i * TAG_STRIDE + 5] * 255f).toInt().coerceIn(0, 255)
            canvas.drawBitmap(s.bitmap, matrix, paint)
        }
    }

    /** Puts tag [i]'s placement, drawing sticker [s], in [matrix]. */
    private fun place(i: Int, s: TagBitmap) {
        val o = i * TAG_STRIDE
        val scale = tags[o + 4]
        matrix.setTranslate(-s.anchorX, -s.anchorY)
        matrix.postScale(scale, scale)
        matrix.postTranslate(tags[o + 2] * width, tags[o + 3] * height)
    }

    /**
     * One tag, at full size: `.name-tag` plus its `::before`/`::after`. The anchor
     * is where the car's projected point goes — the tail's tip sits just above
     * it, because the box's bottom edge is [GAP_EM] above.
     */
    private fun rasterize(name: String, color: Int): TagBitmap {
        val em = FONT_PX * k
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = face
            textSize = em
            this.color = android.graphics.Color.WHITE
        }
        // `line-height: 1` and `padding: 0.14em 0.55em 0.18em`, on a pill.
        val boxW = ceil(text.measureText(name) + 1.1f * em)
        val boxH = ceil(em * 1.32f)
        // The tail's size is still the CSS's `--b`-sized one, which the Toy Box
        // kept when it dropped the outline: `0.3em + b` tall, twice that wide.
        val b = TAIL_B * k
        val tailH = 0.3f * em + b
        val tailW = 2 * tailH
        val bmpH = ceil(boxH + tailH)
        val bitmap = Bitmap.createBitmap(boxW.toInt(), bmpH.toInt(), Bitmap.Config.ARGB_8888)
        val c = Canvas(bitmap)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

        c.drawRoundRect(RectF(0f, 0f, boxW, boxH), boxH / 2, boxH / 2, fill)
        // THE TAIL: one livery triangle, tucked a pixel up into the pill
        // (`top: calc(100% - 1px)`) so no seam shows. The flat tip is the web's
        // soft point.
        c.drawPath(tail(boxW / 2, boxH - k, tailW, tailH), fill)

        // Centred on the content box by the face's own metrics, nudged by the
        // padding's 0.04em asymmetry, so it sits where the browser's line box
        // puts it.
        val fm = text.fontMetrics
        val baseline = (boxH - 0.04f * em) / 2 - (fm.ascent + fm.descent) / 2
        c.drawText(name, em * 0.55f, baseline, text)

        return TagBitmap(name, color, bitmap, boxW, boxH, GAP_EM * em)
    }

    private fun tail(cx: Float, top: Float, w: Float, h: Float) = Path().apply {
        moveTo(cx - w / 2, top)
        lineTo(cx + w / 2, top)
        lineTo(cx + w * 0.04f, top + h * 0.92f)
        lineTo(cx - w * 0.04f, top + h * 0.92f)
        close()
    }

    private companion object {
        /**
         * `clamp(1.2rem, 1.56vw, 1.8rem)` on a 1920-wide display lands on its
         * 28.8 px ceiling, against the name chip's 35 — the ratio this shell's own
         * 35 px chip keeps ([RaceHud]'s NameChip). Fredoka SemiBold, as the web's
         * weight 600. Like the CSS, the CLOSEST size (C++'s scale 1), 4/3 of the
         * usual tag, so the bitmap is only ever scaled down.
         */
        const val FONT_PX = 28.8f
        /** `--b: calc(2px * 4 / 3)`, the tail's size term, at the closest scale. */
        const val TAIL_B = 8f / 3f
        /** The box's bottom edge above the anchor, in em (`translateY(-0.4em)`). */
        const val GAP_EM = 0.4f
        /** Floats per tag in `ttp_display_name_tags`' answer (`ttp_display.h`). */
        const val TAG_STRIDE = 6
    }
}
