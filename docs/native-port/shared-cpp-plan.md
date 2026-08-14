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
| P0 | `libttp-runtime` exists; CI compiles it | 0 | ✅ ~500 lines onto all 4 legs; 2 new ctests |
| P1 | Delete duplication that already exists | 78 gross, net +16 | ✅ dead abandon policy made live; a real bug closed |
| P2 | Design tokens + the protocol manifest as shared data | 0 | ✅ 4 checked links replace 3 prose comments |
| P3 | C++ owns the track payload | ~660 | ✅ `themes.js` gone; `track.bin` 268 → 68 lines |
| P4 | Cross-language wire-compat suite | 0 | ✅ 20 asymmetries found, 3 live bugs |
| P5 | Extract the UI model in JS; record both oracles | ~0 net | ✅ both oracles clean-clone reproducible |
| P6 | Packed HUD + cell rects + steer bar to Filament | ~120 | ✅ 435 rows matched first run |
| P7 | Audio decisions to C++; cues baked | ~230 | ✅ 6397/6397 bit-for-bit |
| P8 | UI model into C++ | **235, not ~1,450** | ✅ 3120/3120; the estimate counted prose |
| P9 | `PartySession` + the schematic codec | partial, by choice | ✅ oracle recorded FIRST; `_applyMode` left in JS |

## What the estimates got wrong

Worth keeping, because the errors were systematic rather than random.

- **P8 was out by 6x.** "~1,450 JS lines retired" counted the FILE; `uiModel.js`
  is roughly half prose. The real figure is 235 code lines, and netted against
  the new adapter the browser's JS shrank by about 75. The value of that phase is
  the second and third shell not re-deriving the model — not bytes on the web.
- **P2 retires nothing.** Its product is *one source for a number*, not one
  implementation of a behaviour. A phase whose output is checks, not deletions.
- **P9 was not a single decision.** Its 70 units split 21 platform / 29 policy /
  15 with NO recorded evidence / 5 already C++. Porting the third group would
  have been porting on faith, so the oracle was recorded first (the P5 pattern)
  and one unit was deliberately left in JS.
- **The per-frame readback was never a performance story.** Measured: 52.35 µs →
  3.26 µs, i.e. 0.29% of a 60 Hz frame. It shipped for the contract.

## The recurring defect, in four subsystems

Every phase that looked hard was hard for the same reason, and it is worth
naming: **a gate nobody has watched fail is not yet a gate.**

- the frozen theme generator imported a symbol that exists in NO commit — the
  oracle for 745 lines of palette was unrenewable one commit after being armed;
- the audio oracle was recorded through `Math.hypot` and `10 ** x`, which V8
  approximates and the vendored fdlibm does not — unmatchable by the port it
  existed to gate, and one ULP there changes which COMMAND fires;
- `hud.cc` built green while leaving the shipped wasm unlinkable, because no
  ctest links the web module;
- four wire mutations pointed at anchors that had ceased to exist, so the gate's
  own demonstration silently tested nothing.

Each was found by an adversarial pass, not by the suite. The suite was green
throughout.

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

### P2 — what it actually was, once looked at

Scoped down to two parts on contact, and the "~250 lines retired" estimate was
wrong: P2 retires **nothing**. It adds checks. That is the honest shape of a
phase whose product is *one source for a number*, not *one implementation of a
behaviour*.

- **CUT: the copy/strings table.** Exactly two user-facing strings live in JS
  (`'Next race'`, `'Next up: '` in `main.js`). All other copy is in the HTML
  markup, which every platform rewrites anyway. A strings table would have been
  ceremony around two strings. The *Decisions taken* note about C++ emitting
  string KEYS still stands — it is about P8's UI model, and lands there.
- **The protocol manifest** (the non-goal above, delivered): `STEER` in
  `public/shared/protocol.js`, mirrored in `protocol.h`, carried by the protocol
  corpus, with `protocol_check` additionally asserting the sim's own
  `getSteerExpo()` equals it. Four checked links replace three prose comments.
- **The design tokens** shipped in the DERIVED direction — `theme.css` stays the
  authored source and `scripts/gen-design-tokens.mjs` bakes
  `public/shared/design-tokens.json` (typed, aliases resolved). A JSON source
  with generated CSS was rejected: theme.css's value is largely its comments,
  and generating it would make the file every UI change touches build output.
  The generator's header carries the full argument. Flipping the direction later
  costs nothing — the JSON shape does not change, only who writes it.

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
- **QR:** no C++ encoder. `CIQRCodeGenerator` on tvOS, ZXing on Android, a
  vendored JS encoder on web — three one-liners are not worth ~600 lines of C++
  to unify. The URL *composition* is shared; only the module bitmap is per-platform.
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
