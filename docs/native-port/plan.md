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
FX, the frozen shadow baked once plus blob shadows, 2×2 split-screen with
per-view billboards, and HUD including one lobby-style panel (QR, names,
list) — driven as a scripted loop through the real interfaces, which are
frozen against it: `ttp_runtime.h`, `FrameInput`, the fixture format.

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
3. **Web integration** behind `?renderer=filament`, the JS engine feeding
   `FrameInput` per frame. Three.js stays the default.
4. **Parity + perf.** Commit fixtures (static scenes and recorded
   `FrameInput` timelines, seeded from the gallery catalogue). Verify
   cheapest-first: structural dumps (logical pose + named cosmetic offsets,
   exact), per-platform screenshot goldens (small perceptual tolerance;
   cross-platform diffs are diagnostic only), and human side-by-side
   checkpoints against Three.js for the sticker look. Head-to-head perf vs
   Three.js on low-end web hardware gates the eventual default flip.
5. **Device fixture hosts** keep running the growing fixture set on both
   floor devices throughout — regressions surface per-step.

## Track S — sim conformance

1. **Repair the oracle first.** Pin an exact Node/V8 build for fixture
   recording; add AI-live traces (AiDriver re-run, not replayed) and
   RaceSession-driven traces; cover mutation APIs, variable dt and the
   endgame; schema the augmented track object; write the C++ FP profile
   (double authoritative, FMA/contraction off, JS `%`/rounding/signed-zero
   semantics, a `JSON.stringify`-matching serializer, the vendored V8
   fdlibm revision named).
2. **Port `libttp-track`** with a standalone sampler corpus (wrap seams,
   negative s, degenerate tangents, `projectNear` clamp ties) so track-math
   mismatches isolate before whole-race failures.
3. **Re-arm the committed fixtures and port `libttp-sim`** to exact
   agreement on every trace. If last-bit matching proves disproportionate
   on some target, the fallback — exact discrete state plus bounded
   numeric tolerances — is decided deliberately, not discovered mid-port.

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
