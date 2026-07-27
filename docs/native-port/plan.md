# Native port: plan

Execution plan for [architecture.md](architecture.md). Gate 0 comes first;
Tracks R and S then run in parallel and meet at integration. Done so far:
the sim contract + golden-trace tooling (PR #19) and the Filament tvOS
port (simulator-proven, packaged).

## Gate 0 — vertical slice (the first code)

One deterministic scene, the same C++ code, on all three platforms —
before any bulk porting. Develop on desktop (macOS Metal), then run on:

- the custom emscripten/WASM build, fed per-frame from JS,
- Apple TV 4K (1st gen) hardware,
- a physical Mali-G31 Android TV.

The scene: a representative track piece (curve, bank, crest, width change,
loop mouth with decals across the seam), four cars (two GLBs, one monster
morph), one of every material family, a skid ribbon, boost and additive
FX, the frozen shadow baked once plus blob shadows, and 2×2 split-screen
with per-view billboards — driven as a scripted loop through the real
interfaces, which are frozen against it: `ttp_runtime.h`, `FrameInput`,
the fixture format. (No HUD: it moved to the shells' native UI, so the
gate covers the 3D only — see architecture.md.)

Measure per platform: CPU/GPU frame time (one view and four), JS→WASM
marshal cost, memory and growth, load time, lifecycle robustness
(destroy/recreate, surface loss), web payload size. Record baselines for
an empty scene and the equivalent Three.js fixture, and set the gate's
thresholds FROM those measurements — the bar is 60 fps with headroom on
the floor devices, and a GPU capture must show shadow work only at scene
build. Thresholds, once set, only tighten; loosening is a decision.

In parallel, the wire slice: a native tvOS host speaks the relay protocol
with an unchanged JS phone against the real relay (mandatory — phones stay
JS forever). A native DataChannel exchange is measured but informative:
the relay fallback ships today, so a fastlane failure means launching
relay-only, not failing the gate.

If Gate 0 fails on a floor device, that's a floor-hardware or approach
decision before anything else proceeds.

## Track R — renderer

1. **Viewer buildout.** Extend the Gate 0 scene code into the desktop
   fixture viewer: the full material inventory (from auditing the shipping
   renderer's material sites), the gltfio car set (UV-shift recolour,
   monster morph), asset loading and failure paths.
2. **Track meshing + FX** over `libttp-track`: ribbon, decals, hills,
   supports, gantry, skids, particles, environment and landmark animation
   — until every gallery scenario builds and animates.
3. **Web integration — DONE.** Ran behind `?renderer=filament` with the sim
   feeding `FrameInput` across the wasm boundary, then cut over: the renderer
   links into the sim's own module, `ttp_display.cc` builds each frame from the
   live `Game` in C++, and Three.js is deleted. Cameras and the split-screen
   cell layout moved to the runtime with it. The judging surface used to get
   there (`/gallery-compare.html`, one sim → two renderers) went with Three.js;
   git history has both.
4. **Parity + perf.** Still open as a DEVICE story: the web side is judged by
   eye against git history now that there is nothing to diff against
   side-by-side. Commit fixtures (static scenes and recorded `FrameInput`
   timelines, seeded from the gallery catalogue) and verify cheapest-first:
   structural dumps (logical pose + named cosmetic offsets, exact), then
   per-platform screenshot goldens (small perceptual tolerance; cross-platform
   diffs are diagnostic only).
5. **Device fixture hosts** keep running the growing fixture set on both
   floor devices throughout — regressions surface per-step.

## Track S — sim conformance — **COMPLETE 2026-07-24** (PRs #24–#29 + M4)

Executed as milestones M0–M4; the original steps below, with outcomes:

0. *(Better than planned)* Instead of pinning a Node/V8 build, V8's math was
   taken OFF the byte path: one vendored fdlibm source
   (`native/vendor/fdlibm/`) is compiled to WASM for the JS engine
   (`engine/math.js`) and natively for C++ — traces became engine- and
   platform-independent, the gate re-armed, fixtures recordable anywhere.
1. **Oracle repaired** — AI-live, RaceSession-driven (countdown ticks,
   racing flip, raceEnd), variable-dt and mutation-API trace kinds;
   augmented-track schema + export; [fp-profile.md](fp-profile.md); all
   validated by adversarial oracle-mutation matrices (which also found and
   closed a countdown beat-drift blind spot; persona cautions wired in).
2. **`libttp-track` ported** — sampler corpus (642 adversarial cases) plus
   an all-20-tracks buildTrack corpus (hexJSON section hashes, decoration
   keys included); bit-exact.
3. **`libttp-sim` ported, fixtures armed** — Game/AiDriver/RaceSession/
   GrandPrix + the headless replay CLI: every committed fixture replays to
   exact agreement. The serializer question resolved: double-conversion's
   `EcmaScriptConverter` IS `JSON.stringify` (52k-case corpus). Last-bit
   matching held everywhere; the tolerance fallback was never needed —
   mutation probes reproduce the JS engine's exact failure hashes.
4. **Platform matrix** — ctest 12/12 on: macOS arm64, linux x64 (CI, every
   PR), emscripten/WASM under Node, and the Apple TV simulator
   (`simctl spawn`, all corpora + all replays). Android NDK arm64
   cross-compiles in CI; on-device replay is scripted-manual until an
   emulator job earns its keep. `native.yml` runs all legs per PR.

## Integration

- `libttp-runtime` composes sim + renderer: native gameplay end-to-end on
  desktop, then the tvOS shell, then Android TV.
- Native networking lands on the wire-compat suite; the fastlane when it
  earns its keep.
- Platform work is scoped here: surface/swapchain lifecycle, remote/D-pad
  input, signing and store packaging, audio sessions, and the asset
  pipeline (texture compression, manifests, streaming, teardown on track
  change).
- **Web cutover**: Filament WASM becomes the default, Three.js is retired,
  the C++ core becomes the conformance reference and the JS engine is
  frozen and archived.
- The tvOS patch upstreaming decision is made: PR opened, or the carry
  cost written down and accepted.
