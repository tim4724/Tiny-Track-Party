import AVFoundation
import AudioToolbox
import Foundation
import os

/// The DEVICE half of the big screen's sound. It decides nothing.
///
/// Which cue, at what gain, which sustained voice at what level, the audibility
/// curve, the curb-scrub throttle, the rocket jet lifecycle, the music pool and
/// its no-repeat shuffle are all `native/libttp-runtime/ttp/audio.cc` behind
/// `ttp_audio.h`, and arrive here as a stream of COMMANDS that `perform` walks
/// in order. This is the Swift counterpart of `public/display/Audio.js`, and it
/// holds exactly what names a platform API: the graph, the limiter, the sample
/// players, the stream.
///
/// Three things cross as CODES rather than as text, and none of them may be
/// mirrored in Swift:
/// - a cue is a `TTP_CUE_*` code, and the whole cue table is DERIVED at boot by
///   walking `ttp_audio_cue_id(1, 2, 3, …)` until NULL;
/// - a voice's identity is an opaque interned SUBJECT, not a car id, so a
///   rocket's sequence number cannot collide with a peer index;
/// - a song is an INDEX resolved once per race through `ttp_audio_song_json`.
///
/// The catalogue's CC-BY attribution is the Licenses board's, baked from
/// `public/shared/credits.js` plus the live music catalogue (the ledger's item
/// 16). Nothing about the playing song is published from here.
@MainActor
final class AudioDevice {

    // MARK: - Construction

    private let log = Logger(subsystem: "games.couchpad.tinytrack", category: "audio")
    private let baseURL: URL
    /// Where a staged song lives, if this build staged one. See [startMusic].
    private let bundledURL: (String) -> URL?
    private let bank: CueBank

    /// How many sounds can be in the air at once. Four human seats × four
    /// sustained voices, plus a jet per rocket, plus whatever one-shots overlap
    /// — 32 is roughly double the worst case anyone has measured, and an idle
    /// slot costs one branch per render block.
    private static let slotCount = 32

    /// Pre-compressor, and that is the point: it is where `Audio.js`'s master
    /// gain sits, so the limiter below sees the same signal level the web's
    /// does. 0.6 is that file's own default (`_volume()`'s fallback). It is NOT
    /// a user volume control — on a TV that is the TV's job — so moving it
    /// changes how hard the limiter works and nothing else.
    private static let masterVolume: Float = 0.6

    /// The display's mute, which is ONE state whatever flipped it — the host
    /// phone's Sound row here, plus the corner button on the web.
    ///
    /// TWO SILENCERS, the same pair `Audio.js` uses and for the same reason: the
    /// master mixer covers every cue, voice and bed the engine renders, and the
    /// music is an `AVQueuePlayer` that never enters that graph (see
    /// `applyMusicVolume`). Muting at the MASTER MIXER and not at the limiter's
    /// output puts it where `bus.js` puts it, so the limiter sees the silence
    /// rather than holding the last loud block's reduction.
    var muted = false {
        didSet {
            guard muted != oldValue else { return }
            masterMixer.outputVolume = muted ? 0 : Self.masterVolume
            applyMusicVolume()
        }
    }

    private let engine = AVAudioEngine()
    private let masterMixer = AVAudioMixerNode()
    private var limiter: AVAudioUnitEffect?
    private var voiceNode: AVAudioSourceNode?
    private var started = false
    private var renderRate: Double = 48_000

    /// The live voice slots, shared with the render thread. Allocated once and
    /// never freed; see `VoiceState` for the ownership rules.
    private let voices: UnsafeMutablePointer<VoiceState>
    /// Guards the `VoiceState` handshake with the render thread. A pointer,
    /// never a stored struct: an `os_unfair_lock` that Swift copies is UB, and
    /// this one is shared with a closure that may not capture `self`. Allocated
    /// once and never freed, like the slots it guards. See `VoiceState` for the
    /// protocol and why an unfair lock is safe on the audio thread.
    private let handshakeLock: UnsafeMutablePointer<os_unfair_lock>
    /// `(cue code, subject)` → slot, for the sustained voices only. One-shots
    /// are fire-and-forget and are not tracked.
    private var live: [VoiceKey: Int] = [:]

    /// Catalogue paths by song index, resolved at most once each.
    private var songs: [Int32: String] = [:]
    private var musicPlayer: AVQueuePlayer?
    private var musicLooper: AVPlayerLooper?
    private var musicURL: URL?
    private var musicLevel: Double = 0

    private var loggedTags: Set<String> = []
    private var loggedBlockVersion = false
    private var loggedStarvation = false
    private var configurationObserver: NSObjectProtocol?

    init(baseURL: URL,
         bundled: @escaping (String) -> Data?,
         bundledURL: @escaping (String) -> URL?) {
        self.baseURL = baseURL
        self.bundledURL = bundledURL
        self.bank = CueBank(bundled: bundled)
        voices = UnsafeMutablePointer<VoiceState>.allocate(capacity: Self.slotCount)
        voices.initialize(repeating: VoiceState(), count: Self.slotCount)
        handshakeLock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        handshakeLock.initialize(to: os_unfair_lock())
    }

    // MARK: - Start

    /// Stand the graph up. Safe to call twice; the second call is a no-op.
    /// A call that THROWS does not count as the first: `started` flips only
    /// once everything below has succeeded, so a failed session activation
    /// leaves the device retryable rather than claiming a graph that never
    /// stood up.
    ///
    /// There is no user-gesture unlock to wait for here — that is a browser
    /// rule, and it is why `Audio.js` has a `resume()` and this does not.
    func start() throws {
        guard !started else { return }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback)
        try session.setActive(true)

        // Read the hardware rate AFTER activating the session, and render at it:
        // then nothing in the graph resamples, and `CueSample` carries its own
        // rate so a 44.1 kHz cue still lands correctly.
        let hardware = engine.outputNode.outputFormat(forBus: 0).sampleRate
        renderRate = hardware > 0 ? hardware : 48_000
        guard let format = AVAudioFormat(standardFormatWithSampleRate: renderRate, channels: 2) else {
            throw AudioDeviceError.noRenderFormat
        }

        // The cue vocabulary, derived rather than mirrored: walk the codes until
        // the wasm runs out of names. There is no list of cue ids in this shell.
        var codes: [Int32: String] = [:]
        var code: Int32 = 1
        while let id = TTP.str(ttp_audio_cue_id(code)) {
            codes[code] = id
            code += 1
        }
        bank.build(codes: codes)

        // ONE source node renders the whole cue mix rather than one node per
        // voice: 32 graph nodes would mean 32 render callbacks, 32 mixer buses
        // and an attach on every squeal. Summing 32 slots in one callback is
        // both cheaper and the only way the level-stop crossfade can stay
        // sample-aligned.
        let states = voices
        let slots = Self.slotCount
        let cues = bank.cues
        let cueCount = bank.cueCount
        let rate = renderRate
        let lock = handshakeLock
        // Named in full rather than through `Self`, which in an instance
        // method's closure is a reference to the dynamic type and therefore to
        // `self` — the one capture this block may not have.
        let node = AVAudioSourceNode(format: format) { isSilence, _, frameCount, output in
            AudioDevice.render(voices: states, slots: slots, cues: cues, cueCount: cueCount,
                               renderRate: rate, lock: lock, frames: Int(frameCount),
                               output: output, isSilence: isSilence)
        }
        voiceNode = node

        let limiter = Self.makeLimiter()
        self.limiter = limiter
        engine.attach(node)
        engine.attach(masterMixer)
        engine.attach(limiter)
        engine.connect(node, to: masterMixer, format: format)
        engine.connect(masterMixer, to: limiter, format: format)
        engine.connect(limiter, to: engine.mainMixerNode, format: format)
        masterMixer.outputVolume = muted ? 0 : Self.masterVolume
        configure(limiter)

        engine.prepare()
        try engine.start()
        started = true

        // An HDMI route change (the TV waking, a receiver switching mode) stops
        // the engine without stopping the game. Nothing else in the app would
        // notice; the symptom is a race that is silent from the second lap.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.restartAfterConfigurationChange() }
        }
    }

    private func restartAfterConfigurationChange() {
        guard started, !engine.isRunning else { return }
        do {
            try engine.start()
        } catch {
            log.error("the engine did not restart after a route change: \(String(describing: error), privacy: .public)")
        }
    }

    enum AudioDeviceError: Error { case noRenderFormat }

    // MARK: - The master bus

    /// The limiter every cue shares, and it is PART OF THE CONTRACT rather than
    /// polish: without an equivalent, dense overlap (eight cars' worth of cues
    /// landing together) reads louder here than on the web build.
    ///
    /// `Audio.js:120-125` is a WebAudio `DynamicsCompressor` at
    /// `threshold -12 dB, knee 24 dB, ratio 6, attack 0.003 s, release 0.25 s`.
    /// Apple's `AUDynamicsProcessor` is the closest thing tvOS has, and the
    /// mapping is:
    ///
    /// - `threshold` → `Threshold`, same units, same meaning.
    /// - `knee` → `HeadRoom`. Both are "the dB-wide soft region above the
    ///   threshold", and both are in dB.
    /// - `ratio` → **nothing**. The Apple AU has no compression-ratio control;
    ///   its slope is implied by threshold + headroom. The one "ratio" it does
    ///   expose is `ExpansionRatio`, which is DOWNWARD EXPANSION and would gate
    ///   quiet distant cues — WebAudio's compressor has no such stage at all,
    ///   so it is pinned to 1 (off) rather than left at its default of 2.
    /// - `attack` / `release` → same names, same units.
    private static func makeLimiter() -> AVAudioUnitEffect {
        var description = AudioComponentDescription()
        description.componentType = kAudioUnitType_Effect
        description.componentSubType = kAudioUnitSubType_DynamicsProcessor
        description.componentManufacturer = kAudioUnitManufacturer_Apple
        return AVAudioUnitEffect(audioComponentDescription: description)
    }

    private func configure(_ limiter: AVAudioUnitEffect) {
        set(limiter, kDynamicsProcessorParam_Threshold, -12)
        set(limiter, kDynamicsProcessorParam_HeadRoom, 24)
        set(limiter, kDynamicsProcessorParam_ExpansionRatio, 1)
        set(limiter, kDynamicsProcessorParam_AttackTime, 0.003)
        set(limiter, kDynamicsProcessorParam_ReleaseTime, 0.25)
    }

    private func set(_ unit: AVAudioUnitEffect, _ parameter: AudioUnitParameterID,
                     _ value: AudioUnitParameterValue) {
        let status = AudioUnitSetParameter(unit.audioUnit, parameter, kAudioUnitScope_Global, 0, value, 0)
        if status != noErr {
            log.error("limiter parameter \(parameter) rejected: \(status)")
        }
    }

    // MARK: - Driving the decisions

    /// One frame of the continuous mix, plus whatever race events fired inside
    /// the last `ttp_update`. `nowMs` is the only thing the decision layer is
    /// ever told about time.
    func frame(nowMs: Double) {
        ttp_audio_frame(nowMs)
        drain()
    }

    /// The session the room can hear. The lobby's attract demo is never bound,
    /// which is what keeps it silent without a mute flag on this side.
    ///
    /// Deliberately does NOT drain: binding drops the previous session's queued
    /// events in C++, and anything that survives comes out of the next frame.
    func bind(session: Int32) {
        ttp_audio_bind(session)
    }

    /// The lobby roster changed — a bigger count is the join plink.
    func roster(count: Int, inLobby: Bool) {
        ttp_audio_roster(Int32(count), inLobby ? 1 : 0)
        drain()
    }

    /// Kill every live voice: the pause overlay, the finish, a return to the
    /// lobby. Without it a frozen frame holds its wind and squeal forever, since
    /// nothing is updating their levels any more.
    func stopVoices() {
        ttp_audio_stop_voices()
        drain()
    }

    /// One car left the race or changed id. The identity crosses as a JSON
    /// SCALAR, which is what `EngineIdentity` exists to keep honest.
    func stopCar(_ id: EngineIdentity) {
        ttp_audio_stop_car(id.json)
        drain()
    }

    /// Start the biome's music, or stop it when `biome` is nil.
    ///
    /// An unknown or empty biome takes the fallback pool rather than silence —
    /// that rule is `audio.cc`'s, not this file's.
    func music(biome: String?) {
        if let biome {
            ttp_audio_music(Int32(TTP_AUD_MUSIC_START), biome)
        } else {
            ttp_audio_music(Int32(TTP_AUD_MUSIC_STOP), nil)
        }
        drain()
    }

    /// The pause overlay holds the song where it was rather than restarting it.
    func setMusicPaused(_ paused: Bool) {
        ttp_audio_music(Int32(paused ? TTP_AUD_MUSIC_PAUSE : TTP_AUD_MUSIC_RESUME), nil)
        drain()
    }

    // MARK: - The command bus

    /// Drain the packed block and perform every command IN ORDER.
    ///
    /// The commands are COPIED out first, and that is not defensive tidiness:
    /// the block is the runtime's own scratch, valid only until the next
    /// `ttp_audio_*` call, and performing a MUSIC START calls
    /// `ttp_audio_song_json`. The web reader hit exactly this and works around
    /// it by deferring song lookups past its decode loop
    /// (`NativeAudio.js:150-163`); a copy is the same fix with none of the
    /// ordering to remember.
    private func drain() {
        guard let block = ttp_audio_drain() else { return }
        guard block.pointee.version == UInt32(TTP_AUDIO_BLOCK_VERSION) else {
            if !loggedBlockVersion {
                loggedBlockVersion = true
                log.error("""
                    audio command block v\(block.pointee.version), expected \
                    v\(UInt32(TTP_AUDIO_BLOCK_VERSION)) — rebuild with \
                    native/scripts/build-runtime-tvos.sh
                    """)
            }
            return
        }
        let count = Int(block.pointee.count)
        guard count > 0, let commands = ttp_audio_cmds(block) else { return }
        // Walk by the block's OWN `stride`, never by `MemoryLayout<TtpAudioCmd>`:
        // the field is carried precisely so a reader survives a record growing
        // at the end (ttp_audio.h names the TtpHudBlock convention, and
        // `DisplayHost.hud()` is the same walk), and anything MOVING a field
        // bumps the version above.
        let stride = Int(block.pointee.stride)
        let base = UnsafeRawPointer(commands)
        var batch = [TtpAudioCmd]()
        batch.reserveCapacity(count)
        for i in 0..<count {
            batch.append(base.load(fromByteOffset: i * stride, as: TtpAudioCmd.self))
        }
        for command in batch { perform(command) }
    }

    private func perform(_ command: TtpAudioCmd) {
        switch command.kind {
        case Int32(TTP_AUD_CUE):
            play(code: command.code, variant: 0, gain: command.level)

        case Int32(TTP_AUD_COUNTDOWN):
            // `level` is 0 on this arm (the packer never sets it), so the beat
            // plays at full. Multiplying by it would silence the countdown.
            play(code: command.code,
                 variant: (command.flags & UInt32(TTP_AUD_F_GO)) != 0 ? 1 : 0,
                 gain: 1)

        case Int32(TTP_AUD_VOICE):
            let modulated = (command.flags & UInt32(TTP_AUD_F_MOD)) != 0
            setVoice(code: command.code, subject: command.subject, level: command.level,
                     rateMul: modulated ? command.rateMul : 1,
                     gainMul: modulated ? command.gainMul : 1,
                     lpMul: modulated ? command.lpMul : 1)

        case Int32(TTP_AUD_VOICE_STOP):
            stop(VoiceKey(code: command.code, subject: command.subject))

        case Int32(TTP_AUD_STOP_ALL):
            // C++ resets its subject interning table on this command, so no
            // subject minted before it is referenced after it — which is why
            // dropping every key here cannot strand a live voice. The key list
            // is snapshotted because `stop` mutates the map it came from.
            for key in Array(live.keys) { stop(key) }

        case Int32(TTP_AUD_STOP_CAR):
            for key in Array(live.keys) where key.subject == command.subject { stop(key) }

        case Int32(TTP_AUD_MUSIC):
            performMusic(command)

        default:
            logUnhandled(tag: command.kind, what: "command kind")
        }
    }

    private func performMusic(_ command: TtpAudioCmd) {
        switch command.code {
        case Int32(TTP_AUD_MUSIC_START):
            // `level` is already MUSIC_LEVEL × the song's LUFS trim
            // (`audio.cc:419`). Applying the song's own gain again would trim it
            // twice.
            startMusic(index: command.subject, level: command.level)
        case Int32(TTP_AUD_MUSIC_STOP):
            musicPlayer?.pause()
            musicPlayer?.seek(to: .zero)
        case Int32(TTP_AUD_MUSIC_PAUSE):
            musicPlayer?.pause()
        case Int32(TTP_AUD_MUSIC_RESUME):
            musicPlayer?.play()
        default:
            logUnhandled(tag: command.code, what: "music op")
        }
    }

    /// Every tag this device does not know about is VISIBLE, once each. A
    /// command silently dropped here looks exactly like a decision layer that
    /// never fired, which is the hardest kind of audio bug to find.
    private func logUnhandled(tag: Int32, what: String) {
        guard loggedTags.insert("\(what):\(tag)").inserted else { return }
        log.error("unhandled audio \(what, privacy: .public) \(tag) — nothing performed it")
    }

    // MARK: - One-shots

    /// Nothing is playable before the graph is up, and nothing is worth queueing
    /// either — the same "no-op safely while locked" `Audio.js` gives every play
    /// method. It also keeps a stopped engine (a route change mid-race) from
    /// filling every slot with voices no render pass will ever free.
    /// Also read from OUTSIDE, by the GO beat: `ttp_race_start_beat_json` gates
    /// the music pick on it, so a device that cannot play yet picks no song at
    /// all rather than burning one from the no-repeat shuffle unheard.
    var ready: Bool { engine.isRunning }

    /// `gain` is the decision layer's own level, distance curve and all. Nothing
    /// is re-applied here: `rocket_hit.wav` was baked WITH its 0.6 trim and its
    /// de-click envelope, so multiplying either back in would double it.
    private func play(code: Int32, variant: Int32, gain: Double) {
        guard let cue = cue(code), cue.kind == .oneShot, Int(variant) < cue.count else {
            logUnhandled(tag: code, what: "one-shot code")
            return
        }
        // `ready` is read OUTSIDE the lock: it calls into the engine, and the
        // render callback runs inside it — holding `handshakeLock` across an
        // engine query invites an ordering nobody has audited.
        guard ready else { return }
        os_unfair_lock_lock(handshakeLock)
        defer { os_unfair_lock_unlock(handshakeLock) }
        guard let slot = freeSlot() else { return }
        let voice = voices + slot
        voice.pointee = VoiceState()
        voice.pointee.cue = code
        voice.pointee.variant = variant
        voice.pointee.gain = gain
        voice.pointee.rate = Self.detune(spread: cue.spread)
        voice.pointee.active = 1
    }

    /// A fresh detune per fire: `2^(U(-spread, +spread)/12)`.
    ///
    /// The bake froze `jitter()` at 1.0 on purpose, so this is not an effect —
    /// it is the missing half of the cue. `screech` fires as often as
    /// `SCREECH_GAP_MS` allows, roughly seven times a second, and without a
    /// fresh rate every fire that is a machine gun of one identical sample.
    private static func detune(spread: Double) -> Double {
        guard spread > 0 else { return 1 }
        return pow(2, Double.random(in: -spread...spread) / 12)
    }

    // MARK: - Sustained voices

    private func setVoice(code: Int32, subject: Int32, level: Double,
                          rateMul: Double, gainMul: Double, lpMul: Double) {
        guard let cue = cue(code), cue.kind == .stops || cue.kind == .engine else {
            logUnhandled(tag: code, what: "voice code")
            return
        }
        let key = VoiceKey(code: code, subject: subject)
        // Belt and braces: the decision layer already sends VOICE_STOP on the
        // falling edge, and `Audio.js` keeps the same guard. It is device
        // behaviour, so it is mirrored rather than trusted away.
        guard level > cue.levelFloor else {
            stop(key)
            return
        }

        // `ready` outside the lock for the same reason as in `play`.
        if live[key] == nil, !ready { return }
        os_unfair_lock_lock(handshakeLock)
        defer { os_unfair_lock_unlock(handshakeLock) }
        let slot: Int
        if let existing = live[key] {
            slot = existing
        } else {
            guard let free = freeSlot() else { return }
            slot = free
            live[key] = free
            let voice = voices + free
            voice.pointee = VoiceState()
            voice.pointee.cue = code
            // The engine voice starts where `bakedLoopVoice` does: unity rate,
            // effectively-silent gain, filter wide shut at `lp0`, all three
            // gliding from there. Anything else is a click on the first frame.
            voice.pointee.rate = cue.kind == .engine ? 1 : 0
            voice.pointee.gain = cue.kind == .engine ? 0.0001 : 0
            voice.pointee.cutoff = cue.lp0
        }
        let voice = voices + slot
        voice.pointee.targetLevel = level
        // The timbre rides the command as NUMBERS so the monster truck's
        // pitch-down stays written down once, in the layer that authored it.
        voice.pointee.rateMul = rateMul
        voice.pointee.gainMul = gainMul
        voice.pointee.lpMul = lpMul
        voice.pointee.active = 1
    }

    private func stop(_ key: VoiceKey) {
        guard let slot = live.removeValue(forKey: key) else { return }
        let voice = voices + slot
        // The slot stays reserved until the tail has faded, which is what stops
        // a re-used slot from clicking. The render thread frees it.
        os_unfair_lock_lock(handshakeLock)
        voice.pointee.releasing = 1
        voice.pointee.releaseFrames = Int(0.5 * renderRate)
        os_unfair_lock_unlock(handshakeLock)
    }

    private func cue(_ code: Int32) -> RenderCue? {
        guard let cues = bank.cues, code > 0, Int(code) < bank.cueCount else { return nil }
        let cue = cues[Int(code)]
        return cue.kind == .none ? nil : cue
    }

    /// The first slot the render thread is done with. Nothing is stolen: a full
    /// pool drops the new sound, because stealing a live one would cut a squeal
    /// mid-corner to make room for a one-shot. Callers hold `handshakeLock`,
    /// which is what makes the `active == 0` read here trustworthy.
    private func freeSlot() -> Int? {
        for slot in 0..<Self.slotCount where voices[slot].active == 0 { return slot }
        if !loggedStarvation {
            loggedStarvation = true
            log.error("all \(Self.slotCount) voice slots are busy — a sound was dropped")
        }
        return nil
    }

    // MARK: - Music

    /// The catalogue is BUNDLED, and streams from the origin only when a build
    /// did not stage it. It always streamed before, on the grounds that the app
    /// depends on that origin anyway — but that dependency is a page load at the
    /// start of a night, and this one was a continuous stream for the length of
    /// every race.
    ///
    /// The path is `audio.cc`'s, UNCHANGED, and that is the whole trick. The
    /// catalogue's `file` is origin-absolute and bakes its `.mp3` extension, and
    /// `audio-corpus.jsonl` froze those strings with its JS oracle deleted — so
    /// the shell keeps the string exactly and only chooses what to resolve it
    /// against. Bundling cost no ABI change and moved no fixture.
    ///
    /// **Moving off MP3 still would.** It would mean making that `file` a stem
    /// (the ledger's R1), and it is worse here than the ledger says: Apple
    /// decodes Opus only inside a CAF container, which ffmpeg cannot mux, so
    /// this leg alone would need a macOS-only encode step.
    private func startMusic(index: Int32, level: Double) {
        guard let file = songFile(at: index) else {
            log.error("no song at catalogue index \(index)")
            return
        }
        // The staged root IS the `/assets/` the baked path names, so the prefix
        // comes off for the local lookup and stays on for the remote one.
        let staged = file.hasPrefix("/assets/")
            ? bundledURL(String(file.dropFirst("/assets/".count)))
            : nil
        guard let url = staged ?? URL(string: file, relativeTo: baseURL)?.absoluteURL else {
            log.error("song \(file, privacy: .public) is not a URL under \(self.baseURL.absoluteString, privacy: .public)")
            return
        }
        musicLevel = level
        // WHICH SOURCE WON, once per song. The fallback degrades in silence by
        // design — that is what makes it safe — so without this line an app that
        // bundles 62 MB of music and streams anyway looks exactly like one that
        // works.
        log.info("music \(file, privacy: .public) from \(staged != nil ? "the bundle" : "the origin", privacy: .public)")

        if musicURL != url {
            // A fresh player per song rather than re-pointing the looper: an
            // AVPlayerLooper owns its queue player's queue, and swapping the
            // template item under a live one is not a supported move. Re-racing
            // the SAME song keeps its player, which is what keeps it buffered.
            musicLooper?.disableLooping()
            musicPlayer?.pause()
            let player = AVQueuePlayer()
            musicLooper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
            musicPlayer = player
            musicURL = url
        } else {
            musicPlayer?.seek(to: .zero)
        }
        applyMusicVolume()
        musicPlayer?.play()
    }

    /// The bed does NOT pass through the limiter on this platform, and that is a
    /// deliberate, documented divergence rather than an oversight: `AVPlayer`
    /// renders to the device, not into an `AVAudioEngine` graph, so there is no
    /// node to connect. This is precisely the path `Audio.js` itself takes when
    /// `createMediaElementSource` is unavailable (`Audio.js:245` — "routed
    /// straight to the device"), including scaling by the master volume so the
    /// balance against the cues is unchanged. Routing it properly would mean an
    /// `MTAudioProcessingTap` on the player item, or downloading the song and
    /// scheduling it through the engine — neither is worth it for a bed that
    /// already arrives LUFS-trimmed.
    private func applyMusicVolume() {
        musicPlayer?.volume = muted ? 0
            : Float(min(max(musicLevel, 0), 1)) * Self.masterVolume
    }

    /// The catalogue path for a song index, memoized. Only the path crosses:
    /// the attribution fields `ttp_audio_song_json` also answers are the
    /// Licenses board's, baked at build time and never read here.
    private func songFile(at index: Int32) -> String? {
        if let cached = songs[index] { return cached }
        let json = TTP.obj(ttp_audio_song_json(index))
        guard let file = json["file"] as? String else { return nil }
        songs[index] = file
        return file
    }

    // MARK: - The render callback

    /// Sum every live slot into the output buffer.
    ///
    /// `nonisolated` and `static` on purpose: this runs on the audio thread, so
    /// it may touch nothing that is main-actor isolated, allocate nothing and
    /// retain no object. Everything it reads arrives as a pointer or a number.
    ///
    /// The ONE lock it takes is `handshakeLock`, around the slot loop, and that
    /// is deliberate rather than a slip: the main thread only ever holds it for
    /// a handful of word stores (never an allocation, a wasm call or I/O), so
    /// the longest this thread can wait is those stores — and `os_unfair_lock`
    /// donates the waiter's priority to the holder, so a preempted main thread
    /// finishes them promptly. Held across the whole mix on THIS side, which
    /// makes main the party that waits, never the audio thread.
    nonisolated private static func render(
        voices: UnsafeMutablePointer<VoiceState>,
        slots: Int,
        cues: UnsafePointer<RenderCue>?,
        cueCount: Int,
        renderRate: Double,
        lock: UnsafeMutablePointer<os_unfair_lock>,
        frames: Int,
        output: UnsafeMutablePointer<AudioBufferList>,
        isSilence: UnsafeMutablePointer<ObjCBool>
    ) -> OSStatus {
        let buffers = UnsafeMutableAudioBufferListPointer(output)
        // Every arm below ADDS, so the block starts from silence.
        for buffer in buffers { memset(buffer.mData, 0, Int(buffer.mDataByteSize)) }
        // The connection format is standard (non-interleaved) STEREO, so there
        // are always two buffers. If that ever stops being true, going silent
        // beats writing past the one buffer that exists — and there is no
        // logging from this thread to say so.
        guard frames > 0, buffers.count > 1,
              let left = buffers[0].mData?.assumingMemoryBound(to: Float.self),
              let right = buffers[1].mData?.assumingMemoryBound(to: Float.self) else {
            isSilence.pointee = ObjCBool(true)
            return noErr
        }

        var voiced = false
        os_unfair_lock_lock(lock)
        for slot in 0..<slots {
            let voice = voices + slot
            guard voice.pointee.active != 0 else { continue }
            guard let cues, voice.pointee.cue > 0, Int(voice.pointee.cue) < cueCount else {
                voice.pointee.active = 0
                continue
            }
            let cue = cues[Int(voice.pointee.cue)]
            switch cue.kind {
            case .oneShot:
                renderOneShot(voice, cue, renderRate, frames, left, right)
            case .stops:
                renderStops(voice, cue, renderRate, frames, left, right)
            case .engine:
                renderEngine(voice, cue, renderRate, frames, left, right)
            case .none:
                voice.pointee.active = 0
                continue
            }
            voiced = true
        }
        os_unfair_lock_unlock(lock)
        isSilence.pointee = ObjCBool(!voiced)
        return noErr
    }

    nonisolated private static func renderOneShot(
        _ voice: UnsafeMutablePointer<VoiceState>, _ cue: RenderCue, _ renderRate: Double,
        _ frames: Int, _ left: UnsafeMutablePointer<Float>, _ right: UnsafeMutablePointer<Float>
    ) {
        guard let samples = cue.samples else { voice.pointee.active = 0; return }
        let sample = samples[Int(voice.pointee.variant)]
        // The file's own rate against the graph's IS the resampling; the detune
        // rides on top of it.
        let step = sample.sampleRate / renderRate * voice.pointee.rate
        let gain = Float(voice.pointee.gain)
        var position = voice.pointee.pos
        for frame in 0..<frames {
            if position >= Double(sample.frames) {
                voice.pointee.active = 0
                break
            }
            let (l, r) = read(sample, position, loop: false)
            left[frame] += gain * l
            right[frame] += gain * r
            position += step
        }
        voice.pointee.pos = position
    }

    /// A loop crossfaded between baked level stops.
    ///
    /// The stops carry only the FILTER — `bakeHeadroom: 1` divided the gain out
    /// of the PCM — so the level does two jobs here: it picks the crossfade
    /// position between adjacent stops, and it feeds the cue's own gain formula.
    /// Both come off ONE glide, because the manifest gives these voices one
    /// `smoothTauSec` and the gain is exactly linear in the level.
    ///
    /// All stops share the loop phase by construction (one read position for the
    /// pair), which is what "sample-aligned" in the manifest asks for.
    nonisolated private static func renderStops(
        _ voice: UnsafeMutablePointer<VoiceState>, _ cue: RenderCue, _ renderRate: Double,
        _ frames: Int, _ left: UnsafeMutablePointer<Float>, _ right: UnsafeMutablePointer<Float>
    ) {
        guard let samples = cue.samples, let levels = cue.levels, cue.count > 0 else {
            voice.pointee.active = 0
            return
        }
        let step = samples[0].sampleRate / renderRate
        let levelGlide = glide(1 / renderRate, cue.tau)
        let releaseGlide = glide(1 / renderRate, max(cue.tau, 0.02))
        var position = voice.pointee.pos
        var level = voice.pointee.level
        var release = voice.pointee.release
        let target = voice.pointee.targetLevel
        let releasing = voice.pointee.releasing != 0
        let gainMul = voice.pointee.gainMul
        let last = cue.count - 1
        let loopFrames = Double(samples[0].frames)

        for frame in 0..<frames {
            level += (target - level) * levelGlide
            if releasing { release -= release * releaseGlide }

            // Locate the pair. Five comparisons at most, and the level moves
            // every sample, so there is nothing to hoist out of the loop.
            // `brake` is the degenerate case — ONE stop, because its 950 Hz Q3
            // bandpass and 11 Hz gate LFO are static, so the pair collapses onto
            // itself and the crossfade weight is 0.
            var upper = min(1, last)
            while upper < last && level > levels[upper] { upper += 1 }
            let lower = max(upper - 1, 0)
            let span = levels[upper] - levels[lower]
            let mix = span > 0 ? min(max((level - levels[lower]) / span, 0), 1) : 0

            let (al, ar) = read(samples[lower], position, loop: true)
            let (bl, br) = read(samples[upper], position, loop: true)
            let gain = Float((cue.gainA + cue.gainB * level) * gainMul * release)
            left[frame] += gain * (al + (bl - al) * Float(mix))
            right[frame] += gain * (ar + (br - ar) * Float(mix))

            position += step
            if position >= loopFrames { position -= loopFrames }
        }
        voice.pointee.pos = position
        voice.pointee.level = level
        voice.pointee.release = release
        finishRelease(voice, frames: frames)
    }

    /// The recorded engine loop with its lowpass kept LIVE.
    ///
    /// Three parameters with three different taus, glided toward targets derived
    /// from the RAW level — that is `bakedLoopVoice`'s shape, and it matters:
    /// `setTargetAtTime` smooths each parameter independently, so smoothing the
    /// level and deriving three values from it would be a different sound.
    nonisolated private static func renderEngine(
        _ voice: UnsafeMutablePointer<VoiceState>, _ cue: RenderCue, _ renderRate: Double,
        _ frames: Int, _ left: UnsafeMutablePointer<Float>, _ right: UnsafeMutablePointer<Float>
    ) {
        guard let samples = cue.samples, cue.count > 0 else { voice.pointee.active = 0; return }
        let sample = samples[0]
        let level = min(max(voice.pointee.targetLevel, 0), 1)
        let targetRate = (cue.rate0 + level * cue.rateSpan) * voice.pointee.rateMul
        let targetGain = (cue.gainA + level * cue.gainB) * voice.pointee.gainMul
        let targetCutoff = (cue.lp0 + level * cue.lpSpan) * voice.pointee.lpMul

        // The cutoff glides once per BLOCK: new coefficients cost a sin and a
        // cos, and a 0.10 s tau does not need 5 ms resolution. Rate and gain
        // glide per SAMPLE — they are one multiply-add each, and a stair on a
        // gain is audible where a stair on a cutoff is not.
        let blockSeconds = Double(frames) / renderRate
        voice.pointee.cutoff += (targetCutoff - voice.pointee.cutoff) * glide(blockSeconds, cue.lpTau)
        let filter = lowpass(cutoff: voice.pointee.cutoff, q: cue.lpQ, renderRate: renderRate)

        let rateGlide = glide(1 / renderRate, cue.rateTau)
        let gainGlide = glide(1 / renderRate, cue.tau)
        let releaseGlide = glide(1 / renderRate, max(cue.tau, 0.02))
        let releasing = voice.pointee.releasing != 0
        let base = sample.sampleRate / renderRate
        var position = voice.pointee.pos
        var rate = voice.pointee.rate
        var gain = voice.pointee.gain
        var release = voice.pointee.release
        var z1a = voice.pointee.z1a, z2a = voice.pointee.z2a
        var z1b = voice.pointee.z1b, z2b = voice.pointee.z2b

        for frame in 0..<frames {
            rate += (targetRate - rate) * rateGlide
            gain += (targetGain - gain) * gainGlide
            if releasing { release -= release * releaseGlide }

            let (l, r) = read(sample, position, loop: true)
            // Transposed direct form II, one biquad per channel — the shape
            // WebAudio's BiquadFilterNode "lowpass" implements.
            let ya = filter.b0 * Double(l) + z1a
            z1a = filter.b1 * Double(l) - filter.a1 * ya + z2a
            z2a = filter.b2 * Double(l) - filter.a2 * ya
            let yb = filter.b0 * Double(r) + z1b
            z1b = filter.b1 * Double(r) - filter.a1 * yb + z2b
            z2b = filter.b2 * Double(r) - filter.a2 * yb

            let out = Float(gain * release)
            left[frame] += out * Float(ya)
            right[frame] += out * Float(yb)

            position += base * rate
            if position >= Double(sample.frames) { position -= Double(sample.frames) }
        }
        voice.pointee.pos = position
        voice.pointee.rate = rate
        voice.pointee.gain = gain
        voice.pointee.release = release
        voice.pointee.z1a = z1a; voice.pointee.z2a = z2a
        voice.pointee.z1b = z1b; voice.pointee.z2b = z2b
        finishRelease(voice, frames: frames)
    }

    /// Free a released slot once its tail has run. 0.5 s is what the web's
    /// voices give themselves (`src.stop(at + 0.5)` in every `stop()`), and it
    /// is why nothing here clicks.
    nonisolated private static func finishRelease(_ voice: UnsafeMutablePointer<VoiceState>, frames: Int) {
        guard voice.pointee.releasing != 0 else { return }
        voice.pointee.releaseFrames -= frames
        if voice.pointee.releaseFrames <= 0 { voice.pointee.active = 0 }
    }

    /// One sample pair, linearly interpolated. Mono is duplicated to both
    /// channels, which is what WebAudio's up-mix does with a mono source into a
    /// stereo destination.
    @inline(__always)
    nonisolated private static func read(_ sample: CueSample, _ position: Double, loop: Bool) -> (Float, Float) {
        let index = Int(position)
        guard index >= 0, index < sample.frames else { return (0, 0) }
        let fraction = Float(position - Double(index))
        // Looping interpolates ACROSS the seam: the baked loops are exactly
        // 1.000 s, so frame 0 is the successor of the last one.
        let next = loop ? (index + 1) % sample.frames : min(index + 1, sample.frames - 1)
        let channels = sample.channels
        let a0 = sample.data[index * channels], a1 = sample.data[next * channels]
        let l = a0 + (a1 - a0) * fraction
        guard channels > 1 else { return (l, l) }
        let b0 = sample.data[index * channels + 1], b1 = sample.data[next * channels + 1]
        return (l, b0 + (b1 - b0) * fraction)
    }

    /// The per-step coefficient of an exponential approach with time constant
    /// `tau` — WebAudio's `setTargetAtTime`, which is what every level, gain,
    /// rate and cutoff in `cues.js` glides with.
    @inline(__always)
    nonisolated private static func glide(_ dt: Double, _ tau: Double) -> Double {
        tau > 0 ? 1 - exp(-dt / tau) : 1
    }

    /// RBJ lowpass, normalised by a0.
    @inline(__always)
    nonisolated private static func lowpass(cutoff: Double, q: Double, renderRate: Double)
        -> (b0: Double, b1: Double, b2: Double, a1: Double, a2: Double) {
        let hz = min(max(cutoff, 20), renderRate * 0.45)
        let w0 = 2 * Double.pi * hz / renderRate
        let cosw = cos(w0)
        let alpha = sin(w0) / (2 * max(q, 0.0001))
        let a0 = 1 + alpha
        return (b0: (1 - cosw) / 2 / a0,
                b1: (1 - cosw) / a0,
                b2: (1 - cosw) / 2 / a0,
                a1: -2 * cosw / a0,
                a2: (1 - alpha) / a0)
    }
}

/// A live voice's key: the cue CODE and the opaque interned SUBJECT.
///
/// The subject is deliberately not a car id (`ttp_audio.h:98-112`). Keying on it
/// is what makes `TTP_AUD_STOP_CAR` exact and what stops a rocket's sequence
/// number from colliding with a peer index.
private struct VoiceKey: Hashable {
    let code: Int32
    let subject: Int32
}

/// One voice slot, shared between the main thread and the render callback.
///
/// Trivial by construction — no Swift references — so the render thread can read
/// and write it through a pointer without ARC.
///
/// **The ownership handshake.** Main fills every field and writes `active = 1`
/// LAST; the render thread writes `active = 0` when the sound is done, and main
/// only ever hands out a slot whose `active` is 0. Every side of that — the
/// fill, `stop()`'s `releasing`/`releaseFrames` stores, the render pass over
/// the slots — runs under `handshakeLock`, whose unlock/lock is the
/// release/acquire pair that publishes the fields before the flag. An
/// `os_unfair_lock` rather than atomics because C atomics do not import into
/// Swift and `Synchronization.Atomic` needs a tvOS 18 floor this shell does not
/// have; it is safe for the audio thread because main's critical sections are a
/// few word stores (never an allocation or a wasm call) and the lock donates
/// the waiter's priority to its holder — see `render`'s own note.
private struct VoiceState {
    var active: Int32 = 0
    var releasing: Int32 = 0
    /// `TTP_CUE_*`, which is also the index into the render table.
    var cue: Int32 = 0
    /// One-shot only: 0 the sound, 1 the GO beat.
    var variant: Int32 = 0
    var pos: Double = 0
    var level: Double = 0
    var targetLevel: Double = 0
    var gain: Double = 0
    var rate: Double = 1
    var cutoff: Double = 0
    var rateMul: Double = 1
    var gainMul: Double = 1
    var lpMul: Double = 1
    var release: Double = 1
    var releaseFrames: Int = 0
    /// Biquad state, one pair per channel.
    var z1a: Double = 0, z2a: Double = 0
    var z1b: Double = 0, z2b: Double = 0
}
