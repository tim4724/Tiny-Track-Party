package games.couchpad.tinytrack

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * The join code's module bitmap, and nothing else.
 *
 * The URL this encodes is composed in shared C++ — `libttp-party/ttp/session.h`'s
 * `join_url`, reached through `ttp_net.h` — so the four URLs a room's identity is
 * spelled into (join / claim / dial / the relay's controller template) are one
 * implementation for three shells. Only the BITMAP is per-platform, because it is
 * three platform one-liners: the web asks its own server (`GET /api/qr?text=`),
 * tvOS asks Core Image, this asks ZXing. **Nothing about the room is decided
 * here** — this takes a string and returns pixels.
 */
object QRCode {

    /**
     * Roughly how many PIXELS wide the finished bitmap should be.
     *
     * A ballpark rather than a contract: the real scale is the largest INTEGER
     * multiple of the module count that fits under it, so the answer lands
     * somewhere in `[target/2, target]`. 800 covers the lobby ticket at 4K without
     * making a bitmap nothing can use.
     */
    private const val TARGET_PIXELS = 800

    /** The QR for [text], or null if it will not encode (empty, or too long). */
    fun bitmap(text: String): Bitmap? {
        if (text.isEmpty()) return null
        return try {
            val hints = mapOf(
                // "L", matching the web server's
                // `QRCode.create(text, { errorCorrectionLevel: 'L' })`.
                // Deliberately the LOWEST level, and on a TV that is the right way
                // round: correction level buys resilience to damage and dirt at the
                // cost of more modules, and more modules on a fixed-size ticket
                // means SMALLER ones. What this code has to survive is being
                // photographed across a room from a clean, backlit, undamaged
                // panel — so every module it does not have is width the ones it
                // does have get to keep.
                EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L,
                // ZXing pads with 4 modules of quiet zone unless told otherwise.
                // ONE, matching `public/shared/qr.js`'s policy: the margin a
                // scanner needs is supplied by what the code is MOUNTED on — the
                // join ticket is a white `--surface` sticker card with its own
                // padding, and the reconnect card the same. Four here would double
                // it and shrink the modules for nothing.
                EncodeHintType.MARGIN to 1,
            )
            // Ask for the module grid at its natural size first, so the scale below
            // can be an exact integer. Passing TARGET_PIXELS straight in lets ZXing
            // pick a non-integer multiple and land module edges mid-pixel.
            val small = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 1, 1, hints)
            val modules = maxOf(small.width, 1)
            val scale = maxOf(1, TARGET_PIXELS / modules)
            val side = modules * scale
            val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, side, side, hints)

            val pixels = IntArray(side * side)
            for (y in 0 until side) {
                val row = y * side
                for (x in 0 until side) {
                    pixels[row + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
                }
            }
            Bitmap.createBitmap(pixels, side, side, Bitmap.Config.ARGB_8888)
        } catch (_: Throwable) {
            null
        }
    }
}
