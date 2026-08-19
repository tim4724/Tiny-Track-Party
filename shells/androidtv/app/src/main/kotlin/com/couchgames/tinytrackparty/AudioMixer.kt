package com.couchgames.tinytrackparty

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * The mix: every cue this shell makes, summed into one always-open stream.
 *
 * The Swift twin is the `render` half of
 * `shells/tvos/TinyTrackParty/Audio/AudioDevice.swift`, and this is its port —
 * same three renderers, same glides, same release tail, same master bus. Read
 * that file for the reasoning behind the DSP; what is written here is what is
 * different because the platform is.
 *
 * ## Why a mixer at all, when SoundPool was already playing the one-shots
 *
 * Four cue families are SUSTAINED — a loop crossfaded between baked level stops
 * in one shared loop phase — and one is the recorded engine loop with a LIVE
 * lowpass whose cutoff tracks the throttle, and SoundPool can do none of that.
 * Why the one-shots moved in with them, and the cold-play trap the always-open
 * stream retires, is the Audio section of `shells/androidtv/CLAUDE.md`.
 *
 * ## Threads
 *
 * ONE thread, started with the device and stopped with it, doing nothing but
 * render-and-write. The shell's other rule — every `ttp_*` call on the main
 * thread — is untouched: the DRAIN stays where it was, and hands what it drained
 * over through [post], a single-producer/single-consumer ring of plain numbers.
 * Nothing is shared but that ring, so there is no lock for the main thread to
 * wait on and no way for this thread to stall a frame. The voice slots and the
 * cue table are read only here.
 */
class AudioMixer(private val bank: CueBank) {

    companion object {
        private const val TAG = "AudioMixer"

        /**
         * The graph's rate, and the device's own (every AudioFlinger output thread on
         * this box is 48 kHz), so the mix reaches the DAC unresampled.
         *
         * The BAKE is not uniformly 48 kHz — `rocket_hit.wav` and `engine_loop.ogg`
         * are 44.1 kHz stereo — so every renderer steps by `sample.rate / RATE` and
         * resamples per voice. Do not hoist that ratio out as 1.0.
         */
        const val RATE = 48_000

        /**
         * 10 ms of stereo. Long enough that the per-block work (one biquad
         * coefficient set per engine voice) is amortised, short enough that the
         * cutoff's 0.10 s glide still has fifty steps per time constant.
         */
        private const val BLOCK = 480

        /**
         * How many sounds can be in the air at once. Four human seats x four
         * sustained voices, plus a jet per rocket, plus whatever one-shots
         * overlap — 32 is roughly double the worst case anyone has measured, and
         * an idle slot costs one branch per block.
         */
        private const val SLOTS = 32

        /** Commands buffered between two blocks. A frame queues at most a handful. */
        private const val QUEUE = 256

        /**
         * Pre-limiter, and that is the point: it is where `audio/bus.js`'s master
         * gain sits, so the limiter below sees the level the web's does. 0.6 is
         * that file's own `DEFAULT_VOLUME`. It is NOT a user volume control — on a
         * TV that is the TV's job.
         *
         * PUBLIC because the MUSIC bed has to be scaled by it too, and is not mixed
         * here. `Audio.js` routes music straight to the device rather than through
         * the bus — an `<audio>` element, as it is a `MediaPlayer` here — but still
         * sets its volume to `level * this._volume()`, so the same 0.6 lands on it.
         * Without that, this shell's music sat 1.67x louder against its cues than
         * the web's does, which is the whole balance of the mix.
         */
        const val MASTER = 0.6f

        // `bus.js`'s soft limiter, verbatim: a WebAudio DynamicsCompressor at
        // threshold -12 dB, knee 24 dB, ratio 6, with that node's default attack
        // and release. It acts on the SUM, so it is part of the contract and not
        // polish — without it, eight cars' cues landing together read louder here
        // than on the web.
        private const val COMP_THRESHOLD = -12.0
        private const val COMP_KNEE = 24.0
        private const val COMP_RATIO = 6.0
        private const val COMP_ATTACK = 0.003
        private const val COMP_RELEASE = 0.25

        /**
         * How often the limiter recomputes its gain, in samples.
         *
         * Per sample would cost a `log10` and a `pow` per sample per channel,
         * which is real money on a Cortex-A55; 16 samples is a third of a
         * millisecond, an order under the 3 ms attack, so the envelope it tracks
         * is unchanged and the applied gain is interpolated across the chunk.
         */
        private const val COMP_STEP = 16

        const val CMD_ONE_SHOT = 1
        const val CMD_VOICE = 2
        const val CMD_VOICE_STOP = 3
        const val CMD_STOP_ALL = 4
        const val CMD_STOP_CAR = 5

        /**
         * The tail a stopped voice fades over, and the longest the web gives any of
         * its own: `cues.js` stops the engine and boost at +0.5 s, corner and brake
         * at +0.4 and rocket_fire at +0.3. One number for all five is the
         * simplification, and it errs toward holding a slot slightly longer rather
         * than clicking. (tvOS carries the same single number and the same tail.)
         */
        private const val RELEASE_SEC = 0.5

        /** The per-step coefficient of an exponential approach — WebAudio's `setTargetAtTime`. */
        private fun glide(dt: Double, tau: Double): Double =
            if (tau > 0) 1.0 - exp(-dt / tau) else 1.0
    }

    /** One live sound. Touched only by the mixer thread, so nothing here is guarded. */
    private class Voice {
        var active = false
        var releasing = false
        var cue = 0
        var subject = 0
        /** One-shot only: 0 the sound, 1 the GO beat. */
        var variant = 0
        var pos = 0.0
        var level = 0.0
        var targetLevel = 0.0
        var gain = 0.0
        var rate = 1.0
        var cutoff = 0.0
        var rateMul = 1.0
        var gainMul = 1.0
        var lpMul = 1.0
        var release = 1.0
        var releaseFrames = 0
        /** Biquad state, one pair per channel. */
        var z1a = 0.0; var z2a = 0.0; var z1b = 0.0; var z2b = 0.0
    }

    private val slots = Array(SLOTS) { Voice() }

    // -- the command ring -------------------------------------------------------
    // Single producer (whoever drains), single consumer (the mixer thread). The
    // fields are written before `head` is published and read after `head` is
    // observed, which is the whole of the ordering this needs.

    private val qKind = IntArray(QUEUE)
    private val qCode = IntArray(QUEUE)
    private val qSubject = IntArray(QUEUE)
    private val qVariant = IntArray(QUEUE)
    private val qLevel = DoubleArray(QUEUE)
    private val qRateMul = DoubleArray(QUEUE)
    private val qGainMul = DoubleArray(QUEUE)
    private val qLpMul = DoubleArray(QUEUE)
    private val head = AtomicInteger(0)
    private val tail = AtomicInteger(0)
    private var droppedLogged = false

    private var track: AudioTrack? = null
    private var thread: Thread? = null
    @Volatile private var running = false

    private val out = FloatArray(BLOCK * 2)

    /** Limiter state, in dB of reduction (<= 0). */
    private var compGain = 0.0

    /** The detune's own RNG: `Math.random` locks a process-wide one. */
    private val rng = java.util.Random()

    /** True once the stream is open. Nothing is worth queueing before it. */
    val ready: Boolean get() = running

    fun start() {
        if (running) return
        val min = AudioTrack.getMinBufferSize(
            RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
        if (min <= 0) { Log.w(TAG, "no stereo float output — every cue stays silent"); return }
        val bytes = max(min, BLOCK * 2 * 4 * 4)   // at least four blocks in flight
        val t = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_GAME)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build())
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                        .setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                        .build())
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(bytes)
                .build()
        } catch (t: Throwable) {
            Log.w(TAG, "could not open the mix stream", t); return
        }
        track = t
        running = true
        t.play()
        thread = Thread({
            // THREAD_PRIORITY_AUDIO, not Thread.MAX_PRIORITY: the Java priority is a
            // hint, this one moves the thread into the scheduler group the platform
            // reserves for audio, which is what keeps the write loop ahead of the
            // renderer on four small cores.
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
            loop(t)
        }, "ttp-mix").also { it.start() }
    }

    fun release() {
        running = false
        // STOP BEFORE THE JOIN. `running` is only read at the top of the loop, and
        // the thread is parked inside a blocking `write` — so joining first waits
        // out the whole timeout and then frees the native track under a thread still
        // inside it. `stop()` is what returns the write.
        try { track?.stop() } catch (_: Throwable) { }
        thread?.join(500)
        thread = null
        track?.release()
        track = null
    }

    /**
     * Hand a command over. Called from whatever thread drained it — never blocks,
     * never allocates, and drops rather than waits if the mixer has fallen behind
     * (which would mean the audio thread is not running at all, and a stalled
     * caller would be the worse failure).
     */
    fun post(kind: Int, code: Int, subject: Int, variant: Int,
             level: Double, rateMul: Double, gainMul: Double, lpMul: Double) {
        val h = head.get()
        if (h - tail.get() >= QUEUE) {
            if (!droppedLogged) { droppedLogged = true; Log.w(TAG, "command ring full") }
            return
        }
        val i = h and (QUEUE - 1)
        qKind[i] = kind; qCode[i] = code; qSubject[i] = subject; qVariant[i] = variant
        qLevel[i] = level; qRateMul[i] = rateMul; qGainMul[i] = gainMul; qLpMul[i] = lpMul
        head.set(h + 1)
    }

    // -- the render thread ------------------------------------------------------

    private fun loop(t: AudioTrack) {
        while (running) {
            apply()
            render()
            // BLOCKING, which is what paces this thread: the write returns when
            // the buffer has room, so the loop runs at the rate the DAC drains.
            val n = t.write(out, 0, out.size, AudioTrack.WRITE_BLOCKING)
            // `running = false` before returning, or [ready] answers yes forever:
            // the ring fills with commands nobody drains, and `audio.ready` keeps
            // telling the race layer this device can play, which burns songs from
            // the no-repeat shuffle unheard.
            if (n < 0) { Log.w(TAG, "write failed ($n) — the mix is down"); running = false; return }
        }
    }

    /** Drain the ring into the slots. Mixer thread only. */
    private fun apply() {
        var i = tail.get()
        val h = head.get()
        while (i < h) {
            val k = i and (QUEUE - 1)
            when (qKind[k]) {
                CMD_ONE_SHOT -> startOneShot(qCode[k], qVariant[k], qLevel[k])
                CMD_VOICE -> setVoice(qCode[k], qSubject[k], qLevel[k],
                    qRateMul[k], qGainMul[k], qLpMul[k])
                CMD_VOICE_STOP -> stopVoice(qCode[k], qSubject[k])
                CMD_STOP_ALL -> for (v in slots) if (v.active && !v.releasing) beginRelease(v)
                CMD_STOP_CAR -> for (v in slots) {
                    if (v.active && !v.releasing && v.subject == qSubject[k]) beginRelease(v)
                }
            }
            i += 1
        }
        tail.set(i)
    }

    private fun freeSlot(): Voice? = slots.firstOrNull { !it.active }

    private fun startOneShot(code: Int, variant: Int, gain: Double) {
        val cue = bank.cue(code) ?: return
        if (cue.kind != CueBank.KIND_ONE_SHOT || variant >= cue.samples.size) return
        val v = freeSlot() ?: return
        reset(v)
        v.cue = code
        v.variant = variant
        v.gain = gain
        // A fresh detune per fire: 2^(U(-spread, +spread)/12). The bake froze the
        // jitter at 1.0 on purpose, so this is not an effect — it is the missing
        // half of the cue. `screech` fires about seven times a second, and without
        // a fresh rate every fire that is a machine gun of one identical sample.
        v.rate = if (cue.spread > 0)
            2.0.pow((rng.nextDouble() * 2.0 - 1.0) * cue.spread / 12.0) else 1.0
        v.active = true
    }

    private fun setVoice(code: Int, subject: Int, level: Double,
                         rateMul: Double, gainMul: Double, lpMul: Double) {
        val cue = bank.cue(code) ?: return
        if (cue.kind != CueBank.KIND_STOPS && cue.kind != CueBank.KIND_ENGINE) return
        // Belt and braces: the decision layer already sends VOICE_STOP on the
        // falling edge, and the web keeps the same guard. It is device behaviour,
        // so it is mirrored rather than trusted away.
        if (level <= cue.levelFloor) { stopVoice(code, subject); return }

        var v = find(code, subject)
        if (v == null) {
            v = freeSlot() ?: return
            reset(v)
            v.cue = code
            v.subject = subject
            // The engine voice starts where the web's `bakedLoopVoice` does: unity
            // rate, effectively-silent gain, filter wide shut at lp0, all three
            // gliding from there. Anything else is a click on the first frame.
            v.rate = if (cue.kind == CueBank.KIND_ENGINE) 1.0 else 0.0
            v.gain = if (cue.kind == CueBank.KIND_ENGINE) 0.0001 else 0.0
            // ENGINE only: a stops voice has no filter, and seeding a field it never
            // reads with the engine's corner frequency is a fact waiting to be wrong.
            v.cutoff = if (cue.kind == CueBank.KIND_ENGINE) CueBank.ENG_LP0 else 0.0
            v.active = true
        }
        v.targetLevel = level
        v.rateMul = rateMul
        v.gainMul = gainMul
        v.lpMul = lpMul
    }

    private fun stopVoice(code: Int, subject: Int) {
        find(code, subject)?.let { beginRelease(it) }
    }

    /**
     * The slot stays reserved until the tail has faded, which is what stops a
     * re-used slot from clicking. [renderStops] and [renderEngine] free it.
     */
    private fun beginRelease(v: Voice) {
        v.releasing = true
        v.releaseFrames = (RELEASE_SEC * RATE).toInt()
    }

    /** A live, un-released voice for this key. A releasing one is already gone. */
    private fun find(code: Int, subject: Int): Voice? =
        slots.firstOrNull { it.active && !it.releasing && it.cue == code && it.subject == subject }

    private fun reset(v: Voice) {
        v.active = false; v.releasing = false
        v.cue = 0; v.subject = 0; v.variant = 0
        v.pos = 0.0; v.level = 0.0; v.targetLevel = 0.0
        v.gain = 0.0; v.rate = 1.0; v.cutoff = 0.0
        v.rateMul = 1.0; v.gainMul = 1.0; v.lpMul = 1.0
        v.release = 1.0; v.releaseFrames = 0
        v.z1a = 0.0; v.z2a = 0.0; v.z1b = 0.0; v.z2b = 0.0
    }

    private fun render() {
        java.util.Arrays.fill(out, 0f)     // every arm below ADDS
        if (bank.ready) {
            for (v in slots) {
                if (!v.active) continue
                val cue = bank.cue(v.cue)
                if (cue == null) { v.active = false; continue }
                when (cue.kind) {
                    CueBank.KIND_ONE_SHOT -> renderOneShot(v, cue)
                    CueBank.KIND_STOPS -> renderStops(v, cue)
                    CueBank.KIND_ENGINE -> renderEngine(v, cue)
                    else -> v.active = false
                }
            }
        }
        master()
    }

    private fun renderOneShot(v: Voice, cue: CueBank.Cue) {
        val s = cue.samples[v.variant]
        // The file's own rate against the graph's IS the resampling; the detune
        // rides on top of it.
        val step = s.rate / RATE * v.rate
        val gain = v.gain.toFloat()
        var pos = v.pos
        var i = 0
        while (i < BLOCK) {
            if (pos >= s.frames) { v.active = false; break }
            val idx = pos.toInt()
            val f = (pos - idx).toFloat()
            val next = min(idx + 1, s.frames - 1)
            val l = lerp(s, idx, next, f, 0)
            val r = if (s.channels > 1) lerp(s, idx, next, f, 1) else l
            out[i * 2] += gain * l
            out[i * 2 + 1] += gain * r
            pos += step
            i += 1
        }
        v.pos = pos
    }

    /**
     * A loop crossfaded between baked level stops.
     *
     * The stops carry only the FILTER — `bakeHeadroom: 1` divided the gain out of
     * the PCM — so the level does two jobs: it picks the crossfade position
     * between adjacent stops, and it feeds the cue's own gain formula. Both come
     * off ONE glide, because the manifest gives these voices one `smoothTauSec`
     * and the gain is exactly linear in the level.
     *
     * All stops share the loop phase by construction (one read position for the
     * pair), which is what "sample-aligned" in the manifest asks for.
     */
    private fun renderStops(v: Voice, cue: CueBank.Cue) {
        val s0 = cue.samples[0]
        val step = s0.rate / RATE
        val levelGlide = glide(1.0 / RATE, cue.tau)
        val releaseGlide = glide(1.0 / RATE, max(cue.tau, 0.02))
        val loopFrames = s0.frames.toDouble()
        val last = cue.samples.size - 1
        var pos = v.pos
        var level = v.level
        var release = v.release
        val target = v.targetLevel
        val releasing = v.releasing
        var i = 0
        while (i < BLOCK) {
            level += (target - level) * levelGlide
            if (releasing) release -= release * releaseGlide

            // Locate the pair. `brake` is the degenerate case — ONE stop, because
            // its 950 Hz Q3 bandpass and 11 Hz gate LFO are static — so the pair
            // collapses onto itself and the crossfade weight is 0.
            var upper = min(1, last)
            while (upper < last && level > cue.levels[upper]) upper += 1
            val lower = max(upper - 1, 0)
            val span = cue.levels[upper] - cue.levels[lower]
            val mix = if (span > 0) min(max((level - cue.levels[lower]) / span, 0.0), 1.0) else 0.0

            val idx = pos.toInt()
            val f = (pos - idx).toFloat()
            // Looping interpolates ACROSS the seam: the baked loops are exactly
            // 1.000 s, so frame 0 is the successor of the last one.
            val next = (idx + 1) % s0.frames
            val a = cue.samples[lower]
            val b = cue.samples[upper]
            val gain = ((cue.gainA + cue.gainB * level) * v.gainMul * release).toFloat()
            val m = mix.toFloat()
            val al = lerp(a, idx, next, f, 0)
            val bl = lerp(b, idx, next, f, 0)
            val l = al + (bl - al) * m
            val r = if (a.channels > 1) {
                val ar = lerp(a, idx, next, f, 1)
                val br = lerp(b, idx, next, f, 1)
                ar + (br - ar) * m
            } else l
            out[i * 2] += gain * l
            out[i * 2 + 1] += gain * r

            pos += step
            if (pos >= loopFrames) pos -= loopFrames
            i += 1
        }
        v.pos = pos; v.level = level; v.release = release
        finishRelease(v)
    }

    /**
     * The recorded engine loop with its lowpass kept LIVE.
     *
     * Three parameters with three different taus, glided toward targets derived
     * from the RAW level — that is the web's `bakedLoopVoice` shape, and it
     * matters: `setTargetAtTime` smooths each parameter independently, so
     * smoothing the level and deriving three values from it would be a different
     * sound.
     */
    private fun renderEngine(v: Voice, cue: CueBank.Cue) {
        val s = cue.samples[0]
        val level = min(max(v.targetLevel, 0.0), 1.0)
        val targetRate = (CueBank.ENG_RATE0 + level * CueBank.ENG_RATE_SPAN) * v.rateMul
        val targetGain = (cue.gainA + level * cue.gainB) * v.gainMul
        val targetCutoff = (CueBank.ENG_LP0 + level * CueBank.ENG_LP_SPAN) * v.lpMul

        // The cutoff glides once per BLOCK: new coefficients cost a sin and a cos,
        // and a 0.10 s tau does not need 10 ms resolution. Rate and gain glide per
        // SAMPLE — one multiply-add each, and a stair on a gain is audible where a
        // stair on a cutoff is not.
        v.cutoff += (targetCutoff - v.cutoff) * glide(BLOCK.toDouble() / RATE, CueBank.ENG_LP_TAU)
        val hz = min(max(v.cutoff, 20.0), RATE * 0.45)
        val w0 = 2.0 * Math.PI * hz / RATE
        val cosw = cos(w0)
        val alpha = sin(w0) / (2.0 * max(CueBank.ENG_LP_Q, 0.0001))
        val a0 = 1.0 + alpha
        val b0 = (1.0 - cosw) / 2.0 / a0
        val b1 = (1.0 - cosw) / a0
        val b2 = b0
        val a1 = -2.0 * cosw / a0
        val a2 = (1.0 - alpha) / a0

        val rateGlide = glide(1.0 / RATE, CueBank.ENG_RATE_TAU)
        val gainGlide = glide(1.0 / RATE, cue.tau)
        val releaseGlide = glide(1.0 / RATE, max(cue.tau, 0.02))
        val base = s.rate / RATE
        var pos = v.pos
        var rate = v.rate
        var gain = v.gain
        var release = v.release
        var z1a = v.z1a; var z2a = v.z2a; var z1b = v.z1b; var z2b = v.z2b
        val releasing = v.releasing
        var i = 0
        while (i < BLOCK) {
            rate += (targetRate - rate) * rateGlide
            gain += (targetGain - gain) * gainGlide
            if (releasing) release -= release * releaseGlide

            val idx = pos.toInt()
            val f = (pos - idx).toFloat()
            val next = (idx + 1) % s.frames
            val l = lerp(s, idx, next, f, 0).toDouble()
            val r = if (s.channels > 1) lerp(s, idx, next, f, 1).toDouble() else l

            // Transposed direct form II, one biquad per channel — the shape
            // WebAudio's BiquadFilterNode "lowpass" implements.
            val ya = b0 * l + z1a
            z1a = b1 * l - a1 * ya + z2a
            z2a = b2 * l - a2 * ya
            val yb = b0 * r + z1b
            z1b = b1 * r - a1 * yb + z2b
            z2b = b2 * r - a2 * yb

            val g = (gain * release).toFloat()
            out[i * 2] += g * ya.toFloat()
            out[i * 2 + 1] += g * yb.toFloat()

            pos += base * rate
            if (pos >= s.frames) pos -= s.frames
            i += 1
        }
        v.pos = pos; v.rate = rate; v.gain = gain; v.release = release
        v.z1a = z1a; v.z2a = z2a; v.z1b = z1b; v.z2b = z2b
        finishRelease(v)
    }

    private fun finishRelease(v: Voice) {
        if (!v.releasing) return
        v.releaseFrames -= BLOCK
        if (v.releaseFrames <= 0) v.active = false
    }

    /** One channel of one frame, linearly interpolated. */
    private fun lerp(s: CueBank.Sample, idx: Int, next: Int, f: Float, ch: Int): Float {
        if (idx < 0 || idx >= s.frames) return 0f
        val a = s.data[idx * s.channels + ch]
        val b = s.data[next * s.channels + ch]
        return a + (b - a) * f
    }

    /**
     * `bus.js`, verbatim: master gain, then the soft limiter, then out.
     *
     * The compressor is WebAudio's static curve — a quadratic soft knee of [COMP_KNEE]
     * dB centred on [COMP_THRESHOLD], then a [COMP_RATIO]:1 slope — with a one-pole
     * attack/release on the reduction. It is an approximation of that node in the
     * one way that matters and is faithful in every way that is audible here: the
     * curve is exact, and only the envelope's lookahead is missing.
     */
    private fun master() {
        val attack = glide(COMP_STEP.toDouble() / RATE, COMP_ATTACK)
        val release = glide(COMP_STEP.toDouble() / RATE, COMP_RELEASE)
        // THE KNEE SITS ABOVE THE THRESHOLD, not astride it. WebAudio's `knee` is
        // "the decibel range above the threshold where the curve transitions to the
        // ratio" — Blink computes its knee ceiling as `threshold + knee` — and this
        // file first spelled it as the textbook CENTRED knee, `[T-W/2, T+W/2]`. That
        // starts compressing 12 dB early: a single rocket_fire at its race cap peaks
        // at -11.9 dBFS and was pulling the whole mix down 2.5 dB, ducking the engine
        // note, the beds and the music and letting go over the 250 ms release. On the
        // web that peak is untouched and the limiter only acts on dense overlap,
        // which is what `bus.js` says it is for.
        val kneeStart = COMP_THRESHOLD
        val kneeEnd = COMP_THRESHOLD + COMP_KNEE
        var i = 0
        while (i < BLOCK) {
            val n = min(COMP_STEP, BLOCK - i)
            // The detector is the block's PEAK, post master gain.
            var peak = 0f
            var j = 0
            while (j < n) {
                val l = abs(out[(i + j) * 2] * MASTER)
                val r = abs(out[(i + j) * 2 + 1] * MASTER)
                if (l > peak) peak = l
                if (r > peak) peak = r
                j += 1
            }
            val db = if (peak > 1e-6f) 20.0 * log10(peak.toDouble()) else -120.0
            val over = when {
                db <= kneeStart -> 0.0
                // Above the knee the slope pivots at the knee's MIDPOINT, which is
                // what makes it continuous with the quadratic below.
                db >= kneeEnd ->
                    (COMP_THRESHOLD + COMP_KNEE / 2) + (db - COMP_THRESHOLD - COMP_KNEE / 2) / COMP_RATIO - db
                else -> {
                    val x = db - kneeStart
                    (1.0 / COMP_RATIO - 1.0) * x * x / (2.0 * COMP_KNEE)
                }
            }
            // Attack when the reduction deepens, release when it lifts.
            compGain += (over - compGain) * (if (over < compGain) attack else release)
            val g = (MASTER * exp(compGain * LN10_OVER_20)).toFloat()
            j = 0
            while (j < n) {
                out[(i + j) * 2] = clamp(out[(i + j) * 2] * g)
                out[(i + j) * 2 + 1] = clamp(out[(i + j) * 2 + 1] * g)
                j += 1
            }
            i += n
        }
    }

    private fun clamp(v: Float): Float = if (v > 1f) 1f else if (v < -1f) -1f else v
}

/** dB -> linear, as an exponent: `10^(db/20)` without the `pow`. */
private val LN10_OVER_20 = ln(10.0) / 20.0
