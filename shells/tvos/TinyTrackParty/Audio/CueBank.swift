import AVFoundation
import Foundation
import os

/// The baked cue palette, read out of the bundle once at boot.
///
/// `public/display/audio/cues.js` synthesises these in WebAudio at runtime;
/// `scripts/bake-cues.mjs` renders that graph offline into 28 WAVs plus a
/// manifest, and THIS shell plays the bake. It ports none of `cues.js` — a
/// native shell has no business re-implementing an oscillator graph, and the
/// bake is the artifact that makes that unnecessary.
///
/// **The manifest is not documentation, it is the contract.** It carries each
/// one-shot's DETUNE SPREAD and each sustained voice's gain formula, glide tau
/// and level stops, and every one of those numbers is quoted verbatim out of
/// `cues.js` by the baker rather than transcribed. Reading them here instead of
/// typing them into Swift is the same rule `Tokens.swift` follows for colour: a
/// number spelled a second time is a number nothing in the tree watches.
///
/// **The jitter is the PLAYER's job, by design.** The bake froze `jitter()` at
/// 1.0 (the manifest's own `note` says so) because jitter only ever multiplies
/// oscillator frequencies, which is dimensionally a sample player's
/// playbackRate — so it can be re-applied at playback, and only at playback. A
/// device that ignores `spread` turns `screech`, which fires as often as
/// `SCREECH_GAP_MS` allows (~7 times a second), into a machine gun firing one
/// identical sample. See the ledger's R17; `AudioDevice.detune` is where it
/// lands.
final class CueBank {

    private let log = Logger(subsystem: "com.couchgames.tinytrackparty", category: "audio")
    private let bundled: (String) -> Data?

    /// Where the staged bundle keeps the bake (`shells/tvos/scripts/stage-assets.sh`
    /// copies `public/assets/audio/cues/` here verbatim).
    private static let cueDir = "audio/cues/"

    /// Loaded samples per cue id, in PLAY order (see `loadOneShot` for why that
    /// is not the manifest's array order for the countdown).
    private var samples: [String: [CueSample]] = [:]
    /// The manifest's per-cue block, kept so `build` can read the playback
    /// numbers without re-parsing.
    private var entries: [String: [String: Any]] = [:]

    /// The render table, indexed by `TTP_CUE_*` code. Built by `build`, then
    /// read by the audio thread through this pointer for the life of the
    /// process — which is why nothing here is ever freed.
    private(set) var cues: UnsafePointer<RenderCue>?
    private(set) var cueCount = 0

    init(bundled: @escaping (String) -> Data?) {
        self.bundled = bundled
        loadManifest()
    }

    // MARK: - The table

    /// Build the code-indexed render table.
    ///
    /// `codes` comes from walking `ttp_audio_cue_id(1, 2, 3, …)` until NULL, so
    /// the vocabulary is DERIVED from the wasm rather than mirrored here. A cue
    /// the wasm names but the bundle has no bake for is a staging bug: it is
    /// logged and left silent rather than faked.
    func build(codes: [Int32: String]) {
        guard cues == nil else { return }
        let n = Int(codes.keys.max() ?? 0) + 1
        let table = UnsafeMutablePointer<RenderCue>.allocate(capacity: n)
        table.initialize(repeating: RenderCue(), count: n)
        for (code, id) in codes {
            guard let cue = renderCue(id) else {
                log.error("no baked cue for '\(id, privacy: .public)' (code \(code)) — run shells/tvos/scripts/stage-assets.sh")
                continue
            }
            table[Int(code)] = cue
        }
        cues = UnsafePointer(table)
        cueCount = n
    }

    private func renderCue(_ id: String) -> RenderCue? {
        guard let entry = entries[id], let files = samples[id], !files.isEmpty else { return nil }
        let playback = entry["playback"] as? [String: Any] ?? [:]
        let store = UnsafeMutablePointer<CueSample>.allocate(capacity: files.count)
        for (i, s) in files.enumerated() { (store + i).initialize(to: s) }

        var cue = RenderCue()
        cue.samples = UnsafePointer(store)
        cue.count = files.count

        switch entry["kind"] as? String {
        case "one-shot":
            cue.kind = .oneShot
            // `jitter: null` (rocket_hit) means no detune at all — it is the one
            // baked one-shot with a recorded source rather than a synth graph.
            cue.spread = num(playback["jitter"] as? [String: Any], "spread") ?? 0

        case "sustained":
            cue.kind = .stops
            // The levels array is indexed in lockstep with the samples, so a
            // short load would read past it. `loadAll` is all-or-nothing for
            // exactly this reason; the guard says so at the line it protects.
            let stops = sortedStops(entry)
            guard stops.count == files.count else {
                log.error("cue '\(id, privacy: .public)': \(files.count) stops loaded of \(stops.count)")
                return nil
            }
            let levels = UnsafeMutablePointer<Double>.allocate(capacity: files.count)
            levels.initialize(repeating: 0, count: files.count)
            for (i, stop) in stops.enumerated() {
                levels[i] = num(stop, "level") ?? 0
            }
            cue.levels = UnsafePointer(levels)
            // gain = a + b*l. The formula is a STRING because the baker quotes
            // it out of cues.js; parsing it keeps that single source. The stops
            // themselves only ever carry the FILTER — `bakeHeadroom: 1` means
            // the gain was divided out of the PCM, so the device applies it.
            guard let formula = playback["gainFormula"] as? String,
                  let linear = Self.linearFormula(formula) else {
                log.error("cue '\(id, privacy: .public)': gainFormula is not linear in l — cannot play it")
                return nil
            }
            cue.gainA = linear.a
            cue.gainB = linear.b
            cue.tau = num(playback, "smoothTauSec") ?? 0.05
            cue.levelFloor = num(playback, "levelFloor") ?? 0.02

        case "passthrough":
            cue.kind = .engine
            cue.gainA = EngineDSP.gain0
            cue.gainB = EngineDSP.gainSpan
            cue.tau = EngineDSP.gainTau
            cue.rate0 = EngineDSP.rate0
            cue.rateSpan = EngineDSP.rateSpan
            cue.rateTau = EngineDSP.rateTau
            cue.lp0 = EngineDSP.lp0
            cue.lpSpan = EngineDSP.lpSpan
            cue.lpQ = EngineDSP.lpQ
            cue.lpTau = EngineDSP.lpTau
            // The engine voice is the one cue with no `levelFloor` of its own;
            // it shares the sustained voices' VOICE_FLOOR (audio.h:64), which
            // the decision layer already applies before it sends a level.
            cue.levelFloor = 0.02

        default:
            return nil
        }
        return cue
    }

    // MARK: - Loading

    private func loadManifest() {
        guard let data = bundled(Self.cueDir + "manifest.json") else {
            assertionFailure("audio/cues/manifest.json is not in the bundle — run shells/tvos/scripts/stage-assets.sh")
            return
        }
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cues = root["cues"] as? [String: [String: Any]] else {
            assertionFailure("audio/cues/manifest.json did not parse as { cues: {...} }")
            return
        }
        // Schema v2 is what this reader knows. A bump means the playback block
        // moved, and a reader that guessed would mis-tune every voice silently.
        if let version = root["version"] as? Int, version != 2 {
            log.error("cue manifest is schema v\(version), this shell reads v2")
        }
        entries = cues
        for (id, entry) in cues {
            switch entry["kind"] as? String {
            case "one-shot": samples[id] = loadOneShot(id, entry)
            case "sustained": samples[id] = loadStops(id, entry)
            case "passthrough": samples[id] = loadEngineLoop(id, entry).map { [$0] } ?? []
            default: log.error("cue '\(id, privacy: .public)': unknown kind")
            }
            if samples[id]?.isEmpty ?? true { samples[id] = nil }
        }
    }

    private func loadOneShot(_ id: String, _ entry: [String: Any]) -> [CueSample] {
        let files = (entry["files"] as? [[String: Any]] ?? []).compactMap { $0["file"] as? String }
        // The countdown is the one cue with two files, and the ORDER is load
        // bearing: `TTP_AUD_F_GO` picks index 1. Sorting by name rather than
        // trusting the manifest's array order, because "which one is the GO
        // beat" is a fact about the file, not about the JSON.
        let ordered = files.filter { !$0.contains("_go") } + files.filter { $0.contains("_go") }
        return loadAll(ordered, cue: id)
    }

    private func loadStops(_ id: String, _ entry: [String: Any]) -> [CueSample] {
        // ASCENDING by level, because the crossfade walks adjacent pairs. brake
        // is the degenerate case: one file, `levelInvariant`, because nothing
        // but the output gain moves with level there. rocket_fire's fourth stop
        // sits at 0.70 rather than 0.75 because `raceMaxLevel` is AUD_PEAK —
        // descriptive, so nothing here reads it.
        loadAll(sortedStops(entry).compactMap { $0["file"] as? String }, cue: id)
    }

    /// All or nothing. A cue that loaded three of its five stops has a crossfade
    /// that walks the wrong pair, and a countdown that loaded only its GO beat
    /// would tick with it — both are staging bugs wearing a tuning bug's face.
    private func loadAll(_ files: [String], cue: String) -> [CueSample] {
        var loaded: [CueSample] = []
        for file in files {
            guard let sample = load(file, cue: cue) else { return [] }
            loaded.append(sample)
        }
        return loaded
    }

    private func sortedStops(_ entry: [String: Any]) -> [[String: Any]] {
        (entry["stops"] as? [[String: Any]] ?? [])
            .sorted { (num($0, "level") ?? 0) < (num($1, "level") ?? 0) }
    }

    /// The ONE passthrough voice: the recorded engine loop, shipped as-is.
    ///
    /// Its lowpass stays LIVE and is deliberately not baked to stops, because
    /// playbackRate is the RPM here and shifts the filtered spectrum with it —
    /// a stop baked at one cutoff would be wrong at every rate but one.
    ///
    /// **Core Audio has no Ogg Vorbis decoder on any Apple platform**, so the
    /// `.ogg` the web ships cannot be read here at all. The staged bundle has to
    /// carry a transcoded copy; the candidates below are the containers that
    /// transcode could reasonably land in. Missing means the engine voice is
    /// silent and every other cue is unaffected, which is why this logs the fix
    /// rather than asserting.
    private func loadEngineLoop(_ id: String, _ entry: [String: Any]) -> CueSample? {
        assertLiveDSPUnchanged(entry)
        let stem = ((entry["source"] as? String) ?? "engine_loop")
            .split(separator: "/").last.map { $0.split(separator: ".").first.map(String.init) ?? "" } ?? ""
        for ext in ["wav", "caf", "m4a"] {
            let path = "audio/\(stem).\(ext)"
            if let data = bundled(path), let sample = decode(data, path: path) { return sample }
        }
        log.error("""
            no playable \(stem, privacy: .public) in the bundle, so the engine voice is silent. \
            Core Audio cannot decode the .ogg the web ships; stage-assets.sh must transcode it \
            (ffmpeg -i public/assets/audio/\(stem, privacy: .public).ogg -c:a pcm_s16le \
            Generated/assets/audio/\(stem, privacy: .public).wav).
            """)
        return nil
    }

    /// The engine's live DSP is the ONE set of numbers this shell has to
    /// transcribe, because the manifest states it as English prose rather than
    /// as fields. This turns a silent drift into a loud one: if a re-bake
    /// retunes the engine, the prose moves and the assert fires.
    ///
    /// The monster-truck mod is deliberately NOT among them — it arrives on the
    /// wire under `TTP_AUD_F_MOD`, and a second copy here is exactly what
    /// `ttp_audio.h:116-121` says not to keep.
    private func assertLiveDSPUnchanged(_ entry: [String: Any]) {
        let prose = ((entry["playback"] as? [String: Any])?["liveDsp"] as? String) ?? ""
        for fragment in EngineDSP.prose where !prose.contains(fragment) {
            assertionFailure("engine_putt liveDsp no longer says \(fragment) — EngineDSP is stale")
        }
    }

    private func load(_ file: String, cue: String) -> CueSample? {
        let path = Self.cueDir + file
        guard let data = bundled(path) else {
            log.error("cue '\(cue, privacy: .public)': \(path, privacy: .public) is not in the bundle")
            return nil
        }
        return decode(data, path: path)
    }

    // MARK: - Decoding

    /// Every baked cue is `pcm_s16le/wav` (the manifest's own `encoding`), so
    /// the RIFF reader is the whole decoder for the shipping set and costs no
    /// temp files. Anything else — only the transcoded engine loop — goes
    /// through Core Audio, so the staging step can pick whatever container it
    /// likes without this file caring.
    private func decode(_ data: Data, path: String) -> CueSample? {
        if let riff = Self.riffPCM16(data) { return riff }
        let ext = (path as NSString).pathExtension
        if let decoded = Self.coreAudio(data, ext: ext.isEmpty ? "wav" : ext) { return decoded }
        log.error("\(path, privacy: .public) is neither 16-bit RIFF PCM nor anything Core Audio reads")
        return nil
    }

    /// A strict canonical RIFF/WAVE reader for 16-bit PCM.
    ///
    /// NOT resampled: `CueSample` carries the file's own rate and the player
    /// advances by `sampleRate / renderRate`, which IS the resampling and costs
    /// one multiply. That matters for exactly one file — `rocket_hit.wav` is
    /// stereo 44.1 kHz where every other cue is mono 48 kHz, and the ledger's
    /// "do not resample" is about the BAKE, not about playback (the browser
    /// resamples it too: `decodeAudioData` renders into the AudioContext's rate).
    private static func riffPCM16(_ data: Data) -> CueSample? {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> CueSample? in
            guard raw.count >= 44 else { return nil }
            func byte(_ o: Int) -> UInt32 { UInt32(raw[o]) }
            func u16(_ o: Int) -> Int { Int(byte(o) | (byte(o + 1) << 8)) }
            func u32(_ o: Int) -> Int { Int(byte(o) | (byte(o + 1) << 8) | (byte(o + 2) << 16) | (byte(o + 3) << 24)) }
            func tag(_ o: Int) -> String {
                String(bytes: [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]], encoding: .ascii) ?? ""
            }
            guard tag(0) == "RIFF", tag(8) == "WAVE" else { return nil }

            var format = 0, channels = 0, bits = 0
            var rate = 0.0
            var dataAt = -1, dataBytes = 0
            var off = 12
            while off + 8 <= raw.count {
                let id = tag(off)
                let size = u32(off + 4)
                let body = off + 8
                guard size >= 0, body <= raw.count else { break }
                if id == "fmt ", size >= 16, body + 16 <= raw.count {
                    format = u16(body)
                    channels = u16(body + 2)
                    rate = Double(u32(body + 4))
                    bits = u16(body + 14)
                } else if id == "data" {
                    dataAt = body
                    dataBytes = min(size, raw.count - body)
                }
                // Chunks are word-aligned: an odd size carries a pad byte.
                off = body + size + (size & 1)
            }
            guard format == 1, bits == 16, channels > 0, rate > 0, dataAt >= 0 else { return nil }

            let frames = dataBytes / (2 * channels)
            guard frames > 0 else { return nil }
            let count = frames * channels
            let out = UnsafeMutablePointer<Float>.allocate(capacity: count)
            out.initialize(repeating: 0, count: count)
            for i in 0..<count {
                let lo = UInt16(raw[dataAt + i * 2])
                let hi = UInt16(raw[dataAt + i * 2 + 1])
                out[i] = Float(Int16(bitPattern: lo | (hi << 8))) / 32768
            }
            return CueSample(data: UnsafePointer(out), frames: frames, channels: channels, sampleRate: rate)
        }
    }

    /// The escape hatch for anything the RIFF reader will not take. Goes through
    /// a temp file because `AVAudioFile` reads a URL and nothing else; that is
    /// acceptable for one file read once at boot, and unacceptable for the 28
    /// cues, which is why the RIFF path exists.
    private static func coreAudio(_ data: Data, ext: String) -> CueSample? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("ttp-cue-\(UUID().uuidString).\(ext)")
        defer { try? FileManager.default.removeItem(at: url) }
        guard (try? data.write(to: url)) != nil,
              let file = try? AVAudioFile(forReading: url) else { return nil }
        let format = file.processingFormat
        let capacity = AVAudioFrameCount(file.length)
        guard capacity > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity),
              (try? file.read(into: buffer)) != nil,
              let channelData = buffer.floatChannelData else { return nil }

        // processingFormat is always float32 NON-interleaved; CueSample is
        // interleaved so the reader's inner loop is one stride.
        let channels = Int(format.channelCount)
        let frames = Int(buffer.frameLength)
        guard channels > 0, frames > 0 else { return nil }
        let out = UnsafeMutablePointer<Float>.allocate(capacity: frames * channels)
        out.initialize(repeating: 0, count: frames * channels)
        for f in 0..<frames {
            for c in 0..<channels { out[f * channels + c] = channelData[c][f] }
        }
        return CueSample(data: UnsafePointer(out), frames: frames, channels: channels,
                         sampleRate: format.sampleRate)
    }

    // MARK: - Manifest helpers

    private func num(_ dict: [String: Any]?, _ key: String) -> Double? {
        (dict?[key] as? NSNumber)?.doubleValue
    }

    /// `gainFormula` → `gain = a + b*l`.
    ///
    /// The four formulas in the bake are `0.1 * l`, `0.07 * l`, `0.14 * l` and
    /// `0.0001 + l * 0.8`, all linear in `l`. Parsing rather than transcribing
    /// keeps `cues.js` the single source, which is the whole reason the baker
    /// quotes the string instead of writing out a number. A formula this cannot
    /// read is a loud failure, never a guess.
    static func linearFormula(_ text: String) -> (a: Double, b: Double)? {
        var a = 0.0, b = 0.0
        for term in text.split(separator: "+") {
            let factors = term.split(separator: "*").map { $0.trimmingCharacters(in: .whitespaces) }
            switch factors.count {
            case 1 where factors[0] == "l": b += 1
            case 1:
                guard let value = Double(factors[0]) else { return nil }
                a += value
            case 2 where factors[0] == "l":
                guard let value = Double(factors[1]) else { return nil }
                b += value
            case 2 where factors[1] == "l":
                guard let value = Double(factors[0]) else { return nil }
                b += value
            default: return nil
            }
        }
        return (a, b)
    }
}

// MARK: - The render thread's view

/// One decoded sound, in raw memory.
///
/// Raw memory rather than a Swift `Array` because the audio thread reads this:
/// touching an Array there can retain its storage, and ARC traffic in a render
/// callback is the classic way to earn a priority-inversion glitch. Allocated
/// once at boot and never freed — the process outlives it either way, and a
/// free would need a handshake with the render thread to be safe.
struct CueSample {
    /// `frames * channels` interleaved float samples.
    let data: UnsafePointer<Float>
    let frames: Int
    let channels: Int
    /// The file's OWN rate. Nothing is resampled at load; the player advances by
    /// `sampleRate / renderRate` per output frame.
    let sampleRate: Double
}

enum CueRenderKind: Int32 {
    case none = 0
    /// Fire and forget, with a fresh detune per fire.
    case oneShot
    /// A loop crossfaded between baked level stops.
    case stops
    /// The recorded engine loop with live rate / gain / lowpass.
    case engine
}

/// Everything the render callback needs about one cue, as plain old data.
///
/// Trivial by construction: no Swift references, so the callback can read it
/// through a pointer without touching ARC.
struct RenderCue {
    var kind: CueRenderKind = .none
    /// One-shot: `[0]` the sound, `[1]` the GO beat when the cue has two.
    /// Stops: the level stops, ASCENDING. Engine: `[0]`.
    var samples: UnsafePointer<CueSample>?
    /// The stops' levels, ascending, `count` of them.
    var levels: UnsafePointer<Double>?
    var count = 0
    /// One-shot detune, in semitones either side of unity.
    var spread = 0.0
    /// `gain = gainA + gainB * level`, from the manifest's `gainFormula`.
    var gainA = 0.0
    var gainB = 0.0
    /// The level (stops) or gain (engine) glide, in seconds.
    var tau = 0.0
    /// Below this a voice is silent; the decision layer's `VOICE_FLOOR`.
    var levelFloor = 0.0
    // Engine only.
    var rate0 = 0.0, rateSpan = 0.0, rateTau = 0.0
    var lp0 = 0.0, lpSpan = 0.0, lpQ = 0.0, lpTau = 0.0
}

/// The engine voice's live DSP, transcribed from the manifest's `liveDsp` prose.
///
/// This is the only place in the shell where a bake number is typed rather than
/// read, and it is a gap in the manifest rather than a decision: `liveDsp` is a
/// sentence, so there is nothing to parse. `CueBank.assertLiveDSPUnchanged`
/// holds it to that sentence. A machine-readable `liveDsp` block would delete
/// this type outright.
enum EngineDSP {
    static let rate0 = 0.9, rateSpan = 0.75, rateTau = 0.12
    static let lp0 = 900.0, lpSpan = 5200.0, lpQ = 0.6, lpTau = 0.10
    static let gain0 = 0.007, gainSpan = 0.06, gainTau = 0.08

    /// What the manifest's prose must still say for the numbers above to be true.
    static let prose = ["Q 0.6", "(900 + 5200*l)", "tau 0.10 s",
                        "(0.9 + 0.75*l)", "tau 0.12 s",
                        "(0.007 + 0.06*l)", "tau 0.08 s"]
}
