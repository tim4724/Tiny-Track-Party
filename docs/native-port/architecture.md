# Native port: architecture

The target stack for the native port of Tiny Track Party. The sim contract
lives in [contract.md](contract.md) with schemas under [contract/](contract/);
the execution plan is [plan.md](plan.md).

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
  tvOS support — that port is ours (simulator-proven, branch
  `tvos-v1.74.0`, packaged via `build.sh -p tvos`). Three.js remains the
  web default until the Filament path proves parity and performance behind
  a `?renderer=filament` flag.
- **The JS engine stays the shipping web game and the conformance oracle**
  (golden traces, exact replay) until cutover; then the C++ core becomes
  the reference, new fixtures are recorded from it, and the JS engine is
  frozen and retired from oracle duty.

## Layers

| Layer | Language | Contents |
|---|---|---|
| Track math (`libttp-track`) | C++ | Canonical track data, sampling/frames, wrap rules, projection. Deterministic, purity-scanned. |
| Sim core (`libttp-sim`) | C++ | Physics, AI, items, ranking, race lifecycle (incl. RaceSession). Deps: track + vendored math only. |
| Renderer (`libttp-renderer`) | C++ | Filament scene build, all meshing over libttp-track, material families, FX, in-scene HUD. |
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
  renderers or shells. Still missing: a schema for the augmented track
  object (builder output + hazards/pads/boxes/poles + identity).
- **One public C ABI.** `ttp_runtime.h` — lifecycle, input injection, and
  one outbound event queue — is the only boundary a non-C++ caller crosses
  in production; Swift, Kotlin and JS shells are three thin wrappers over
  it. Everything else is internal C++ headers. No ABI versioning
  machinery: all boundaries deploy atomically; versioning lives on
  persisted data only (`CONTRACT_VERSION`, `trackMathVersion`).
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
- **HUD in-renderer.** Everything with the Sticker Bash look is drawn by
  the renderer (concrete game-state structs in, no UI toolkit); shells draw
  only OS-forced surfaces. Validated early on a lobby-class panel (QR,
  names, lists) — the race HUD is the easy case. Fallback: platform UI.
- **Fastlane is an enhancement.** CONTROL falls back to the relay by design
  (shipping behaviour), so the TVs may launch relay-only. Phones stay on
  the JS controller forever, so a cross-language wire-compat suite (C++
  host ↔ unchanged JS phone ↔ real relay) is permanent.
- **Camera**: the runtime owns camera state and cell layout; the renderer
  owns viewports and per-view billboard mechanics.
- **Audio**: logic in the runtime; device output via miniaudio (CoreAudio /
  AAudio / WebAudio).
- **Placement rule of thumb**: if two platforms would ever need it, it's
  C++; a shell may only contain code that names a platform API.

## Known hard parts

- **The custom WASM link doesn't exist.** `build.sh -p wasm` ships a
  JS-binding bundle, not linkable libraries — our emscripten target
  (renderer + Filament libs + canvas glue, threading decided) is new work.
- **Frozen sun shadow.** Filament has no `shadowMap.autoUpdate = false`;
  bake-once needs a custom design and must never re-render per view.
- **No built-in Lambert** — the cheap-matte look is a custom material.
- **Bit-exact conformance** needs vendored V8 fdlibm, a written FP profile
  (double, FMA off, JS `%`/rounding semantics, matching serializer) and an
  exactly pinned Node/V8 oracle. Today's traces exercise neither AiDriver
  (inputs are recorded) nor RaceSession (replay constructs `Game`) — both
  need new trace kinds before the port starts.
- **Renderer scope** is ~8,200 lines (`SceneRenderer.js` + `render/`),
  including procedural canvas textures and nameplate text rasterization.
- **Floor hardware**: Apple TV 4K (1st gen) — the Apple TV HD is
  unsupported — and a Mali-G31-class Android TV.
- **No fallback renderer.** The code targets Filament's API directly;
  switching to bgfx/Diligent would be a restart, not a swap.
