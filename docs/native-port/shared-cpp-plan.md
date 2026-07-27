# Shared C++: finishing the split

Execution plan for the second half of [architecture.md](architecture.md): move
every remaining shared decision into C++, and leave the shells holding only what
names a platform API.

[plan.md](plan.md) covers Tracks R and S (renderer + sim). This covers what was
left behind: the UI model, audio, the track payload, and the party layer's
residue. Written 2026-07-27, after the sim, the cup layer, the party decisions
and the Filament renderer were all already native.

## The rule

> If two platforms would ever need it, it's C++; a shell may only contain code
> that names a platform API.

Staying platform-native BY DECISION (not by inertia):

- **The 2D UI.** DOM/CSS on web, SwiftUI on tvOS, Compose on Android TV.
- **Network transport.** The socket and the `RTCPeerConnection` themselves.
- **The audio device.** WebAudio / CoreAudio / AAudio.

Everything else is shared: the UI *model*, the audio *decisions*, the network
*decisions*, and the whole scene payload.

## Two exceptions worth naming

**The steer bar and the cell dividers move INTO the renderer.** They are the
only two HUD elements that are both cell-anchored and textless. architecture.md
pushed the HUD to the shells because the Sticker Bash look is a UI-toolkit
problem — variable-font shaping, rounded rects, hard offset shadows, transitions
— and Filament is not one. That objection does not apply to a rounded rect with
a translating fill and no type in it. Moving them also makes the entire remaining
HUD a ~6 Hz poll rather than a per-frame stream, which is a far cleaner contract
for three shells than each writing its own 60 Hz animation over a GL surface.

The line, so this does not become three exceptions:

> Cell-anchored AND textless → renderer. Anything carrying type or sticker
> chrome → shell.

That admits the steer bar and the dividers, and keeps out the place/lap ordinal,
the name chip, the item slot, the FINISHED card and the reconnect QR.

**The renderer then owns cell layout outright.** `bestGrid` exists three times
today (`Stage.js`, `TtpRenderer::bestGridCols`, and the runtime's caller), pinned
to each other by a comment. It becomes one `static inline` in the shared
plain-data header, and the shell asks *where the cells are* instead of
recomputing it.

## Audio: logic, recipes and device are three different questions

- **Decisions → C++.** Which cue fires, the `audibility()` distance curve,
  engine pitch/gain vs speed, the shared curb-scrub throttle, rocket jets, music
  pool + no-repeat shuffle + per-song LUFS gain. Pure function of snapshot +
  events.
- **The DSP palette → baked, not ported.** `cues.js` is not a sample player: it
  is ~695 lines of hand-built WebAudio graphs (oscillators, biquads, LFOs,
  envelopes) with only two recorded samples. It already documents itself as
  working under `OfflineAudioContext`, so a build step renders every cue and
  variant to sample files using the *existing, approved* synthesis — identical
  sound by construction. Porting it to miniaudio would mean reimplementing the
  `DynamicsCompressor` limiter and every `setTargetAtTime` glide, then re-tuning
  a mix that took five audition rounds and nine rejected engine variants to
  settle. This is the one place a mechanically correct port produces an audibly
  WRONG result.
  - Caveat: the five sustained voices (boost, corner, brake, engine,
    rocket_fire) sweep a filter with level, so baking loses the sweep. Either
    bake level stops and crossfade, or keep ~80 lines of C++ noise+biquad.
    Decide by ear.
- **Device → two implementations, not three.** WebAudio on web; miniaudio in
  C++ for tvOS and Android TV. Full-wasm audio on the web is blocked by a build
  choice already made: emscripten's AudioWorklet path requires
  `-sAUDIO_WORKLET -sWASM_WORKERS`, worklets always run in a Wasm Worker, and
  that needs SharedArrayBuffer → COOP/COEP cross-origin isolation, which this
  deployment deliberately avoids (single-threaded Filament, no COOP/COEP). The
  non-worklet fallback runs on the main thread beside the Filament render loop
  and glitches on every frame hitch. The browser also decodes the MP3s for free.

## Phases

Each is independently shippable with named proof. All land on one branch
(`c++ui`) as a single PR, by decision — committed incrementally so a bisect
still works inside the branch.

| | Phase | JS retired | Risk |
|---|---|---|---|
| P0 | `libttp-runtime` exists; CI compiles it | 0 | med |
| P1 | Delete duplication that already exists | ~78 gross, net +16 | low |
| P2 | Design tokens, strings, catalogue as shared data | ~250 | low |
| P3 | C++ owns the track payload | ~450 | high |
| P4 | Cross-language wire-compat suite | 0 | med |
| P5 | Extract the UI model in JS; record both oracles | ~0 net | med |
| P6 | Packed HUD block + cell rects + steer bar to Filament | ~120 | med |
| P7 | Audio decisions to C++; cues baked | ~230 | high |
| P8 | UI model into C++ | ~1,450 | high |
| P9 | `PartySession` + the schematic codec | ~810 | high |

### P0 — `libttp-runtime` exists

~500 lines of camera, framing and frame-assembly logic in `ttp_display.cc`
currently compile on exactly one machine configuration in the world and get zero
coverage from any of the 33 ctests on any of the four legs, because they sit
behind the Filament gate CI cannot build. Splitting the ~70 emscripten lines out
into `ttp_display_web.cc` puts the rest on linux, macOS, wasm-under-node and the
tvOS simulator for the first time. Compiling it is not the deliverable, though:
two ctests EXECUTE it on all four legs — `runtime_check` (the quantized camera,
framing and grid corpus) and `frame_check` (the per-frame `TtpFrameInput`
assembly, plus the one binding between the frozen `TTP_CAM_*` macros and the
library's `CamMode`, which must not live in the Filament-gated shim where no CI
leg would compile it).

`solveFraming` stops calling the renderer and takes `TrackFraming` +
`maxOrbitDist` as inputs. Both are pure functions over the track samples and only
live in `TtpRenderer` because it owns the parsed `TrackBin`; P3 moves their
producers too.

### P5 — record the oracles, and note the ratchet

**This is time-sensitive.** The one-way ratchet is already visible in the tree:
`gen-roomflow-corpus.mjs` and `gen-grandprix-corpus.mjs` can no longer *run*,
because their JS twins are gone. Every phase that deletes JS makes the
corresponding oracle unrecordable forever. P5 extracts the UI model as a pure,
testable JS layer and records the UI-model and audio-command oracles **while the
JS that can produce them still exists** — which is why it precedes P6/P7/P8
rather than following them.

Two classes of fixture, and only one settles parity questions
(`tests/fixtures/traces/README.md`): JS-recorded is cross-implementation
evidence; C++-authored is regression evidence only. P0's `runtime_check` corpus
and `frame_check` assertions are both the latter and are labelled as such.

### P6 — the honest reason

The per-frame `ttp_snapshot_json` + `JSON.parse` readback is ~68.5 µs against a
16.67 ms frame. That is **0.41%**, and it is a cost that exists only because the
shell is JS — the TVs never pay it. This phase ships for the CONTRACT
architecture.md already names ("per-frame HUD state per player plus the cell
viewport rects"), not for the speed. Packed struct, never JSON, and never a
composed English string in a HUD field.

## Decisions taken

- **Carrier:** packed struct with a versioned header and contiguous slot arrays,
  mirroring `TtpFrameInput`. The dense-index objection that killed the earlier
  packed-readback proposal is answered by working code: `ttp_display.cc` fixes
  slots at build and matches by id per frame.
- **Strings:** C++ emits semantic values plus stable string keys
  (`{titleKey: 'cup_champs', cupName: 'Sunset', raceIndex: 2}`), never
  `'SUNSET CHAMPS!'`. The copy table ships as data from the same mechanism as
  the design tokens, so localization and platform dynamic-type stay possible.
  Player names and track names pass through as data, not keys.
- **QR:** no C++ encoder. `CIQRCodeGenerator` on tvOS, ZXing on Android, the
  existing endpoint on web — three one-liners are not worth ~600 lines of C++ to
  unify. The URL *composition* is shared; only the module bitmap is per-platform.
- **`scenerySeeds`:** freeze the quirk bit-for-bit. It reads
  `track.id || track.name` off the `buildTrack` OUTPUT, which has neither field,
  so it is effectively `String(Math.round(length * 100))`. All 20 rounded lengths
  happen to be unique, so nothing collides today. "Fixing" it silently reshuffles
  every tree, rock, landmark and clutter piece on all 20 tracks — a visual change
  disguised as a bug fix, landing inside a 700-line port. Same treatment for
  `hazard.cones = 4` and the `scenery<i>.glb` Set dedupe order that the renderer
  binds by.

## Non-goals

- **The phone controller page.** Phones stay on the JS controller forever, and
  for all three TV platforms the phone is a browser. The full controller payload
  is 216 KB against a 2.7 MB wasm, and a guest scans a QR at a party on
  cellular. There is one consumer now and one in five years, so porting reduces
  no implementation count. Ship contracts instead (P2 schemas, P4 wire-compat).
- **A C++ `InputGate` twin.** Mechanically the easiest port available and
  permanently single-consumer. Put `STEER_EXPO` / `ROLL_LOCK` in the protocol
  manifest and gate them with a drift test — ten lines instead of a port, and it
  fixes the actual failure mode: a three-file numeric chain enforced today by
  prose comments alone.
- **`Haptics.js`.** A TV has no vibration motor. The second-consumer set is
  permanently empty.
- **The screen back-stack TRAVERSAL.** The screen enum and the per-screen back
  EFFECT table are shared; `ttp_ui_back()` as a traversal API is the History API
  wearing a C hat. Web has two flags that exist only to tame that API, tvOS is
  Menu + focus engine + `NavigationStack`, Android TV is a backstack the OS
  partly owns.
- **`LobbyDemo` and the attract-demo composer.** Clean to port, but an attract
  mode is a per-platform product decision nobody has asked a TV for.
- **DOM/CSS and the component kit.** architecture.md explicitly accepts three
  implementations of the sticker look; P2's data tables are the stated
  mitigation.
- **Touching `TrackBuilder.js`, `Centerline.js`, `tracks.js` or `genTracks.js`
  as anything but oracles.** They are simultaneously the frozen conformance
  oracle and the codegen source for `track_defs.h`. They leave the runtime path
  in P3 and stay in the repo forever.
- **Deleting `ttp_snapshot_json`.** It stays byte-identical forever for
  `abi_check` and the 8 golden traces; the shipping game simply stops calling it
  after P7.
- **Rewriting the E2E suite.** "The DOM ids and `window.__*` globals do not
  change" is a hard constraint on every phase, not a hope. Treat it as optional
  and you are rewriting the specs while changing the thing under test.

## Risk accepted

P8 and P9 were originally gated behind Gate 0 producing a real TV shell, on the
grounds that no prior port in this repo ever lacked either a live second consumer
or a frozen JS-recorded oracle, and a UI model ported before any TV shell exists
has neither. That gate was lifted by decision: the phases run now. The accepted
cost is that some of the UI-model ABI is a guess about what SwiftUI's focus
engine and Compose's nav backstack will want, and the guess gets frozen into both
a C ABI and a recorded corpus. The back-stack traversal is excluded from P8
precisely because it is the part most likely to be wrong.
