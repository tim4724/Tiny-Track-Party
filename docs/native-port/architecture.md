# Native port: architecture decision record

Status: decided 2026-07-17. This document records the target stack for the
native port of Tiny Track Party, the principles that keep it tractable, the
known risks, and the sequencing gates. The sim contract it depends on lives in
[contract.md](contract.md) with machine-readable schemas under
[contract/](contract/).

## Context

The shipping game is a browser party racer: the TV "display" runs a
display-authoritative Three.js sim (`public/display/engine/Game.js`), phones
are controllers over a WebSocket relay plus a WebRTC fastlane. We want native
apps on living-room platforms (Apple TV first, Android TV next) without
forking the game logic per platform and without breaking the web game, which
keeps shipping throughout.

## Decision

- **C++ rewrite of the game engine.** The sim core (Game, Centerline,
  TrackBuilder data path, AiDriver) is rewritten in portable C++ and shared by
  every platform. It is conformance-tested against the JS engine, which
  remains BOTH the shipping web game and the reference implementation. The
  oracle is executable: golden traces recorded from the JS engine
  (`scripts/record-trace.mjs`, `scripts/verify-trace.mjs`,
  `tests/fixtures/traces/`) replay against any engine build and demand exact
  agreement frame by frame.
- **Filament renderer on all three platforms.** Google Filament renders the 3D
  scene on tvOS and Android TV natively. The web moves to Filament's WASM
  build later; until then Three.js keeps shipping the web renderer unchanged.
  Note there is no official Filament tvOS support: that port is ours (see
  Risks).
- **Thin native shells.** Swift on tvOS, Kotlin on Android TV. Shells own the
  window, input, audio device, and lifecycle; they contain no game logic.
- **Networking ported natively per platform.** The relay protocol and fastlane
  (`partyplug/`) get native counterparts. This is de-risked: `partyplug/` is a
  fork of the HexStacker-Party kit, and that project already carries proven
  native ports of the same protocol, so the message vocabulary and the
  reconnection/liveness semantics are known to survive the translation.

## Principles

### 1. Contract-first

The seam between sim and everything else is a versioned, serializable
contract: the snapshot (`getSnapshot()`), the results (`getResults()`), the
event stream (`onEvent`), the input message (`{s, b, u}`), and the built-track
data (`buildTrack()`). The JS engine already emits pure plain data across this
seam (no vector classes, no live references), stamps it with
`CONTRACT_VERSION` (`public/display/engine/contract.js`), and the purity test
(`tests/portable-purity.test.js`) polices the boundary. The C++ core is done
when it reproduces the golden traces bit for bit at the same contract version.
Anything not in the contract is not available to renderers or shells, on any
platform.

### 2. Thin backend, fat shared core

Everything computable stays in the shared core; renderers are thin backends.
The core owns physics, AI, items, ranking, track geometry (centerline frames,
pillars, hills, support posts, collision poles), and race lifecycle. A
renderer consumes poses, prop lists, and events; it never derives gameplay
state and never re-implements track math. When a feature needs a computed
value, the core computes it and the contract carries it. This is what keeps
three renderers (Three.js today, Filament native, Filament WASM) from
tripling the cost of every feature.

### 3. Material archetypes

The scene is built from exactly four material archetypes:

1. **Matte vertex-colour**: road ribbon, lawn, berms, hills, scenery tints.
2. **Glossy car paint**: car bodies (the only shiny surfaces).
3. **Unlit decal**: painted road markings, boost pads, start grid stripes.
4. **Transparent skid ribbon**: connected alpha-blended trail geometry.

New content must reuse an existing archetype. Each renderer implements four
materials once, and art then never generates per-renderer work. A proposal
that needs a fifth archetype is an architecture change, not a content change,
and gets reviewed as one.

## Risks

- **The Filament tvOS port is unproven.** Filament has no official tvOS
  target; making it build and render there is our work. A dedicated spike is
  Plan A and runs as a separate handoff (early results are promising: an
  availability-gated patch renders the gltfio car scene on the Apple TV
  simulator, but device validation and upstreaming remain open). Fallback
  renderers if the spike fails: bgfx or Diligent.
- **Android TV GPU floor.** Target hardware bottoms out around Mali-G31-class
  GPUs. The web renderer's perf lessons apply (frozen baked shadows, Lambert
  for matte surfaces, chunked road for culling), but Filament's pipeline must
  be profiled on floor hardware early, not after art parity work.
- **Art parity between renderers.** Same assets, two lighting models. The
  material-archetype rule bounds the surface area, but tone mapping, shadow
  look, and the sticker-flat aesthetic need side-by-side comparison
  checkpoints so the platforms do not drift apart visually.

## Sequencing gates

Each gate must pass before the next stage starts:

1. **Contract prep (this branch).** Sim path free of three.js and platform
   clocks, plain-data snapshot, versioned contract, boundary query API,
   golden-trace tooling plus committed fixtures, schemas and this document.
2. **tvOS spike.** Filament rendering on Apple TV hardware (Plan A, separate
   handoff). Exit criteria: gltfio car scene at 60 fps on device, patch
   upstreamable or maintainably carried.
3. **C++ core conformance.** The C++ engine replays every committed golden
   trace with exact agreement at the pinned contract version, on all target
   compilers/platforms. Exact agreement is only achievable with vendored math:
   the JS engine's byte path leans on `Math.sin/cos` (Vec3.applyAxisAngle,
   TrackBuilder arcs), `Math.atan2` (heading, pose twist), `Math.exp` (spin
   drag), `Math.pow` (steer expo) and `Math.hypot` (TrackBuilder), none of
   which are correctly rounded or specified beyond roughly 1 ulp. V8 ships its own fdlibm port whose last-bit
   results differ from glibc, MSVC CRT and Apple libm, so a C++ core that
   links system libm WILL fail hash comparison on some frame regardless of
   correctness. The port must vendor transcendental routines that reproduce
   V8's results bit for bit (start from V8's fdlibm port in
   `src/base/ieee754.cc`; core-math is the fallback source). Plain arithmetic
   and `Math.sqrt` are exact IEEE-754 everywhere and need no special handling.
   A conformance failure should be suspected as a libm mismatch FIRST, an
   engine bug second.
4. **Renderer bring-up.** Filament scene construction from the track contract
   (ribbon, props, cars, the four archetypes), then shells, then native
   networking.
