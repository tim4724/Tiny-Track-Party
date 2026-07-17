# native/

Skeleton for the native port. No build systems yet; this directory only pins
the intended layout so the port lands in a known shape. The decision record is
[docs/native-port/architecture.md](../docs/native-port/architecture.md); the
sim contract the C++ core must implement is
[docs/native-port/contract.md](../docs/native-port/contract.md).

## Intended layout

```
native/
  core/       C++ game engine: the port of public/display/engine/ plus
              Centerline, TrackBuilder (data path), AiDriver, RaceSession.
              Platform-free, no renderer, no networking. Conformance-tested
              against the JS engine's golden traces (tests/fixtures/traces/,
              tooling in scripts/record-trace.mjs and scripts/verify-trace.mjs).
  appletv/    tvOS app: Swift shell + Filament renderer + native networking.
  android/    Android TV app: Kotlin shell + Filament renderer + native
              networking.
```

This mirrors the proven structure of the HexStacker-Party project (the same
core/shell split; `partyplug/` here is a fork of its transport kit, and its
native networking ports are the template for ours).

## Ground rules

- The JS engine (`public/display/engine/`) stays the shipping web game AND the
  reference implementation. `core/` is done when it replays every committed
  golden trace bit for bit at the pinned `CONTRACT_VERSION`.
- Shells stay thin: window, input, audio device, lifecycle. All game logic
  lives in `core/`.
- Renderers consume the contract (snapshot, events, built track) and nothing
  else, and build the scene from the four material archetypes (see the
  architecture doc).
- The Filament tvOS port is Plan A and runs as a separate handoff (Filament
  has no official tvOS target; the spike proves ours). Do not start `appletv/`
  renderer work before that gate passes.
