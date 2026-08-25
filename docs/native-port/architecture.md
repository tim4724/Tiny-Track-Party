# Native port: architecture

The target stack for the native port of Tiny Track Party. The sim contract
lives in [contract.md](contract.md) with schemas under [contract/](contract/);
the execution plan is [plan.md](plan.md). What a new platform actually owes
once every shared layer is C++ — audited against the tree rather than planned —
is [shells.md](shells.md).

## Goal

Native apps on Apple TV and Android TV alongside the existing web game, with
ONE implementation of every shared layer — sim, track math, renderer,
runtime, protocol — and per-platform code reduced to shells and socket
drivers. The web game keeps shipping throughout.

## Stack

- **C++ for every shared layer.** Filament is C++, the conformance math is a
  C transliteration job, and one language keeps every internal boundary a
  plain header — one toolchain everywhere, including emscripten.
- **Google Filament renders on all three platforms**: native on the TVs, a
  custom emscripten/WASM build on the web. There is no official Filament
  tvOS support — that port is ours, shipped on device; the fork commit is
  pinned in `native/filament.pin`. The web cutover is DONE:
  Filament is the only renderer, Three.js is deleted, and the renderer links
  into the SAME wasm module as the sim, so no frame state crosses to JS.
- **The sim cutover is DONE.** The C++ core is the shipping web engine and
  there is no JS fallback. The retired JS engine's golden traces stay the
  conformance evidence and are never re-recorded from C++ — that would only
  prove C++ matches itself. `npm run revive:js-oracle` restores the twin from
  git and re-records all 8 traces byte-identically; while it passes, the parity
  evidence is renewable.

## Layers

| Layer | Language | Contents |
|---|---|---|
| Track math (`libttp-track`) | C++ | Canonical track data, sampling/frames, wrap rules, projection. Deterministic, purity-scanned. |
| Sim core (`libttp-sim`) | C++ | Physics, AI, items, ranking, race lifecycle (incl. RaceSession). Deps: track + vendored math only. |
| Renderer (`libttp-renderer`) | C++ | Filament scene build, all meshing over libttp-track, material families, FX. World-anchored overlays only; no screen-space UI. |
| Runtime (`libttp-runtime`) | C++ | Game loop, session/GP state machine, camera state + cell layout, audio logic, UI model, protocol wiring. |
| Protocol (`libttp-party`) | C++, sans-IO | Relay framing, room semantics/liveness, fastlane state. Sockets/RTC injected. |
| Socket/RTC driver | per-platform | Browser APIs on web (JS, permanent); native WS + webrtc SDK on the TVs. |
| Shell | Swift / Kotlin / JS | Surface, input, lifecycle, audio device, system UI. No logic. |

Extra build targets: a headless trace-replay CLI (links `libttp-sim` and
its two deps, nothing else — the conformance gate) and a desktop fixture
viewer (the renderer dev harness).

## Rules

- **Contract-first.** All data crossing the sim boundary is the versioned
  plain-data contract (contract.md); anything not in it does not exist for
  renderers or shells. The augmented track object (builder output +
  hazards/pads/boxes/poles + identity) is schema'd by
  `contract/race-track.schema.json` and dumped as canonical-JSON fixtures by
  `scripts/export-track-data.mjs`.
- **One public C ABI.** `ttp_runtime.h` and its siblings (`ttp_party.h`,
  `ttp_display.h`, `ttp_ui.h`, `ttp_race.h`, `ttp_net.h`, `ttp_audio.h`,
  `ttp_theme.h`) are the only boundary a non-C++ caller crosses in production.
  Everything else is internal C++ headers. No ABI versioning machinery: all
  boundaries deploy atomically; versioning lives on persisted data only
  (`CONTRACT_VERSION`, `trackMathVersion`).
  THE WRAPPERS ARE NOT EQUALLY THIN, which the original wording ("three thin
  wrappers") hid. Swift consumes a C header directly and JS has `cwrap`; the
  JVM has neither, and the web shell touches well over a hundred distinct
  exports. The Android shell answered that with a generated JNI bridge
  (`scripts/gen-jni.mjs`). See [shells.md](shells.md).
- **A shell reads shared constants, it does not copy them.** The manifest
  (`public/shared/protocol.js`, mirrored 1:1 in
  `native/libttp-party/ttp/protocol.h`) crosses to non-C++ shells whole through
  `ttp_protocol_manifest_json`. What comes out of that export is pinned to
  `protocol.js` by `tests/config-drift.test.js` and to the library by
  `abi_check`; a table retyped into Kotlin or Swift is pinned by nothing, and
  will drift silently the first time a number moves.
- **One renderer call per frame.** `submitFrame(FrameInput{ticks: [{snapshot,
  events, dt}], ui, views})` — events ride inside their tick, and a timeline
  fixture is just a recorded `FrameInput` sequence. Exact shapes settle in
  code; the docs don't spec them.
- **One track math.** Sim and renderer both link `libttp-track` — double
  precision, one operation order, strict FP flags on the library target.
  Renderers never re-derive track semantics; tessellation, decal
  triangulation and caching are presentation policy on top.
- **Material families, keyed by rendering behaviour**: lit surface, unlit/
  decal, translucent FX, screen-space UI, sky/background. glTF import is an
  allowlist mapping onto them. New variant in a family = renderer work; new
  family or render pass = architecture change. The real inventory comes
  from auditing the shipping renderer, not from this list.
- **HUD in the SHELL, in platform-native UI** (reversed 2026-07-25 — the
  original decision was in-renderer with platform UI as the fallback). The
  split is anchored vs screen-space, not 2D vs 3D: the renderer draws what
  lives in the world or depth-tests (boost aura, skids,
  the gantry banner); everything in screen space (place card, lap pill,
  item slot, name chip, countdown, results, lobby) is DOM/CSS on web,
  Compose on Android TV, SwiftUI on tvOS. The Sticker Bash look IS a UI
  toolkit problem — variable-font text shaping, rounded rects, hard offset
  shadows, layout, transitions — and Filament is not one; the in-renderer
  stub got as far as a 5×7 pixel font before that became obvious. The HUD
  is chrome over the 3D view, never frame-locked to it, so compositing a
  native layer over the GL/Metal surface costs nothing that matters. The
  contract is per-frame HUD state per player plus the cell viewport rects,
  which the runtime already computes. Cost accepted: three implementations
  of the sticker look; mitigate by shipping the design tokens as DATA so
  all three consume the same table the CSS does.
- **Fastlane is an enhancement.** CONTROL falls back to the relay by design
  (shipping behaviour), so the TVs may launch relay-only. Phones stay on
  the JS controller forever, so a cross-language wire-compat suite (C++
  host ↔ unchanged JS phone ↔ real relay) is permanent.
- **Camera**: the runtime owns camera state and cell layout; the renderer
  owns viewports and per-view billboard mechanics.
- **Audio**: logic in the runtime; the device half is per-platform by
  decision — AVAudioEngine/Swift on tvOS, AudioTrack/Kotlin on Android,
  WebAudio on the web (the audio-device item of [shells.md](shells.md)'s
  "What every shell owes").
- **Placement rule of thumb**: if two platforms would ever need it, it's
  C++; a shell may only contain code that names a platform API.

## Known hard parts

- **The custom WASM link** ~~doesn't exist~~ — RESOLVED 2026-07-24, and the
  original claim overstated the gap: `build.sh -p wasm` builds the full static
  lib set under emscripten with working (un-guarded) install rules; the new
  work was only our app target, canvas glue and a `ninja install`
  (`scripts/build-wasm.sh`, `native/web/`). Single-threaded is Filament's
  shipped web configuration (no COOP/COEP needed). M0 baselines (spinning
  triangle on the since-retired `/native-m0.html`, M4 Max, emscripten 6.0.4,
  fork + `-Wno-unused-template` patch): payload 1.20 MB wasm + 61 KB glue,
  ~137 µs/frame `ttp_submit_frame` (marshal + single-threaded render call),
  28.5 MB wasm heap, display-limited 120 fps, destroy/recreate clean.
- **Frozen sun shadow.** Filament has no `shadowMap.autoUpdate = false`;
  bake-once needs a custom design and must never re-render per view.
- **No built-in Lambert** — the cheap-matte look is a custom material.
- ~~**Bit-exact conformance**~~ SOLVED. Vendoring fdlibm took V8's math off the
  byte path entirely, so no pinned Node/V8 oracle was needed and traces record
  anywhere. The FP profile ([fp-profile.md](fp-profile.md): double, FMA off, JS
  `%`/rounding semantics, matching serializer) is the standing contract. The
  AI-live and RaceSession-driven trace kinds the port needed both exist.
- **Renderer scope** is ~8,200 lines (`SceneRenderer.js` + `render/`),
  including procedural canvas textures and nameplate text rasterization.
- **Floor hardware**: Apple TV 4K (1st gen) — the Apple TV HD is
  unsupported — and, on Android TV, the audited reference box: a Google TV
  Streamer (PowerVR GE9215; see `shells/androidtv/CLAUDE.md`).
- **No fallback renderer.** The code targets Filament's API directly;
  switching to bgfx/Diligent would be a restart, not a swap.
- **Asset delivery** is settled: every shell stages the full list, music
  included — [shells.md](shells.md)'s "Asset delivery: everything ships"
  bullet carries the resolution contract `ttp_audio_song_json`'s index
  depends on.
- **A TV app has no origin of its own.** The join QR and the controller URL
  template are composed from a base URL (`session.h`), so the web deployment is
  a runtime dependency of every native shell.
- **CI's Android legs compile but do not execute.** CI builds both ABIs
  (armeabi-v7a is the primary — the reference box is 32-bit userspace) and
  links the whole renderer artifact, but no runner has a TV, so no fixture
  runs in CI. The fixtures run on real hardware instead:
  `native/scripts/android-device-spawn.sh` drives the whole ctest suite on a
  box over adb — a scripted-manual run, and the answer to
  [fp-profile.md](fp-profile.md)'s statement-level contraction risk.
