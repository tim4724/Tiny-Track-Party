package games.couchpad.tinytrack

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View
import androidx.compose.ui.graphics.toArgb
import kotlin.math.ceil
import kotlin.math.sqrt

/**
 * The name tags over every other car in each cell, CPU included — the Android
 * half of the web's `Stage._paintNameTags` and its `.name-tag` CSS.
 *
 * **THE ONE HUD ELEMENT PLACED PER FRAME, AND WHY IT IS NOT COMPOSE.** A tag
 * rides a moving car, so it moves on every presented frame, and Compose shares
 * this thread with the renderer: a recomposition that reaches layout costs 10-30
 * ms on the box (`shells/androidtv/CLAUDE.md`). This is a plain View for the
 * reason [PerfOverlayView] is one. WHERE each tag goes is C++'s
 * (`ttp_display_name_tags`, read by [DisplayHost] right after the frame it
 * describes); this decides nothing.
 *
 * **A STICKER IS DRAWN ONCE, NOT PER FRAME.** Each car's tag — livery fill, ink
 * outline, tail, white Fredoka — is rasterized into a Bitmap when its name or
 * colour changes, and a frame only draws those bitmaps through a matrix. No text
 * is shaped and nothing is allocated on the frame path.
 *
 * Sits UNDER the ComposeView, so the cell chips and cards paint over a tag that
 * drifts beneath them, as on the web.
 */
class NameTagView(context: Context) : View(context) {

    private class TagBitmap(val name: String, val color: Int, val bitmap: Bitmap,
                          val anchorX: Float, val anchorY: Float)

    /** C++ writes into this directly ([DisplayHost]); [count] says how much of it is live. */
    val tags = FloatArray(MAX_TAGS * TAG_STRIDE)
    private var count = 0

    /** Slot i's car id, latched per scene build by [DisplayHost]. */
    private var slots: List<EngineId> = emptyList()
    private var stickers = HashMap<EngineId, TagBitmap>()

    /** Authored pixels (1920 wide) to this window's physical pixels. */
    private val k = resources.displayMetrics.widthPixels / AUTHORED_WIDTH
    private val face = Typeface.createFromAsset(context.assets, "fonts/Fredoka-Bold.ttf")
    private val matrix = Matrix()
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)

    init {
        isFocusable = false
        setWillNotDraw(false)
    }

    /**
     * Who the field is: re-rasterizes only the stickers whose name or livery
     * moved, and drops the ones whose car left. Called whenever the scene's cars
     * change (a build, a rename), never per frame.
     */
    fun setField(cars: List<SceneCar>) {
        val next = HashMap<EngineId, TagBitmap>(cars.size * 2)
        for (car in cars) {
            val color = Tokens.car(car.colorIndex).toArgb()
            val have = stickers[car.id]
            next[car.id] = if (have != null && have.name == car.name && have.color == color) have
                else rasterize(car.name, color)
        }
        stickers = next
        invalidate()
    }

    /** The scene's slot order, off the built roster (`ttp_display_slot_ids_json`). */
    fun setSlots(ids: List<EngineId>) { slots = ids }

    /** How many tags C++ just wrote into [tags]; 0 hides them all. */
    fun show(n: Int) {
        if (n == 0 && count == 0) return
        count = n
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        for (i in 0 until count) {
            val o = i * TAG_STRIDE
            val slot = tags[o + 1].toInt()
            val s = stickers[slots.getOrNull(slot) ?: continue] ?: continue
            val scale = tags[o + 4]
            matrix.setTranslate(-s.anchorX, -s.anchorY)
            matrix.postRotate(TILT)
            matrix.postScale(scale, scale)
            matrix.postTranslate(tags[o + 2] * w, tags[o + 3] * h)
            paint.alpha = (tags[o + 5] * 255f).toInt().coerceIn(0, 255)
            canvas.drawBitmap(s.bitmap, matrix, paint)
        }
    }

    /**
     * One tag, at full size: `.name-tag` plus its `::before`/`::after`. The anchor
     * is where the car's projected point goes — the tail's tip sits just above
     * it, because the box's bottom edge is [GAP_EM] above.
     */
    private fun rasterize(name: String, color: Int): TagBitmap {
        val em = FONT_PX * k
        val border = Sticker.border.value * k
        val radius = Tokens.radius("r-sm").value * k
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = face
            textSize = em
            this.color = android.graphics.Color.WHITE
        }
        // `line-height: 1` and `padding: 0.25em 0.5em`, border-box.
        val boxW = ceil(text.measureText(name) + em + 2 * border)
        val boxH = ceil(em * 1.5f + 2 * border)
        val tailH = 0.45f * em + border
        val tailW = 2 * tailH
        val bmpH = ceil(boxH + tailH)
        val bitmap = Bitmap.createBitmap(boxW.toInt(), bmpH.toInt(), Bitmap.Config.ARGB_8888)
        val c = Canvas(bitmap)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG)

        // The ink outline is the box itself, and the livery an inset of it with
        // the inner radius CSS gives a border-box corner.
        fill.color = Tokens.ink.toArgb()
        c.drawRoundRect(RectF(0f, 0f, boxW, boxH), radius, radius, fill)
        fill.color = color
        val inner = (radius - border).coerceAtLeast(0f)
        c.drawRoundRect(RectF(border, border, boxW - border, boxH - border), inner, inner, fill)

        // THE TAIL: an ink triangle hung from the INNER edge of the bottom outline,
        // then the same triangle in the livery lifted by border * sqrt(2). On
        // 45-degree sides that lift is exactly one border perpendicular to each
        // side, so the ink runs as one band from the box round the tip. The flat
        // tip is the web's soft point.
        val top = boxH - border
        fill.color = Tokens.ink.toArgb()
        c.drawPath(tail(boxW / 2, top, tailW, tailH), fill)
        fill.color = color
        c.drawPath(tail(boxW / 2, top - border * sqrt(2f), tailW, tailH), fill)

        // Centred on the content box by the face's own metrics, so it sits where
        // the browser's line box puts it.
        val fm = text.fontMetrics
        val baseline = boxH / 2 - (fm.ascent + fm.descent) / 2
        c.drawText(name, border + em * 0.5f, baseline, text)

        return TagBitmap(name, color, bitmap, boxW / 2, boxH + GAP_EM * em)
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
         * `clamp(1rem, 1.3vw, 1.5rem)` on a 1920-wide display lands on its 24 px
         * ceiling, against the name chip's 35 — the ratio this shell's own 35 px
         * chip keeps ([RaceHud]'s NameChip).
         */
        const val FONT_PX = 24f
        /** The box's bottom edge above the anchor, in em (`translateY(-0.55em)`). */
        const val GAP_EM = 0.55f
        const val TILT = -2f
        const val TAG_STRIDE = 6
        /** Eight cars, so seven tags a cell, across the most cells a field can split into. */
        const val MAX_TAGS = 8 * 7
    }
}
