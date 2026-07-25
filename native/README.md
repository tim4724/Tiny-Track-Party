# native/

The C++ engine. The sim, the cup-series layer and the party layer's decisions all
run here — compiled to WASM for the browser (and natively for the TV shells).
There is no JS engine to fall back on.

Decision record: [docs/native-port/architecture.md](../docs/native-port/architecture.md).
Sim contract: [docs/native-port/contract.md](../docs/native-port/contract.md).
FP rules: [docs/native-port/fp-profile.md](../docs/native-port/fp-profile.md).

## Layout

```
include/        ttp_runtime.h — the ONE C ABI every shell drives (create/resize/
                provide_asset/build_scene/submit_frame/destroy + FrameInput).
renderer/       libttp-renderer: platform-free Filament renderer (no platform or
                emscripten includes). Ships identically on web/tvOS/Android.
                Built + judged against Three.js in /gallery-compare.html.
web/            wasm shell: WebGL2 context bind + ABI impl + CMake link against
                the fork's emscripten SDK. Built by scripts/build-wasm.sh →
                public/native/ (gitignored). Filament fork: ~/Projects/filament,
                branch tvos-v1.74.0 (carries the tvOS port + newer-clang fixes).
                NOT built by native/CMakeLists.txt — it configures standalone
                (emcmake) because it needs the Filament SDK.
libttp-track/   Vec3, Centerline, TrackBuilder, JS-parity math shims.
                generated/track_defs.h carries the 20 shipped layouts.
libttp-sim/     Game (physics/items/ranking), AiDriver, RaceSession, GrandPrix.
libttp-json/    Canonical JSON (sorted keys, ECMA-262 shortest-form numbers)
                + the parser. Byte-identical to JSON.stringify by contract.
libttp-party/   RoomFlow, relay framing, fastlane netcode. Sans-IO: the host
                owns the socket and the RTCPeerConnection.
runtime/        The two public C ABIs: ttp_runtime.h (sim) and ttp_party.h
                (party). No C++ types cross them.
mathlib/        Vendored fdlibm — transcendentals off V8's implementation, so
                traces are platform-independent.
replay/         replay_cli — the golden-trace conformance gate.
probe/          probe_cli — the balance instruments (lap times, car matrix).
*test/          ctest suites, one per library plus the ABI.
```

## Build and test

```bash
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/build -j8
ctest --test-dir native/build            # 32 tests
```

The browser artifacts are **checked in**. After touching anything under
`native/`, rebuild and commit them:

```bash
native/scripts/build-runtime-web.sh      # -> public/display/engine/native/
```

`tests/native-artifact.test.js` compares BUILD_STAMP.json's source hash against
the tree and fails when the shipped wasm drifts.

## Ground rules

- **Fixtures under `tests/fixtures/` are JS-recorded evidence.** They were
  recorded against the JS engine while it existed and are the only proof the
  port is correct. Never re-record them from C++ — that proves only that C++
  matches itself. C++-authored fixtures (`replay_cli --record`) are regression
  evidence, a weaker claim; see `tests/fixtures/traces/README.md`.
- **Strict FP is the determinism contract.** `-ffp-contract=off`, no fast-math,
  transcendentals through `ttp/dmath.h`. Operation order is load-bearing.
- **Own cross-race state per `Game`.** Traces race one track per process, so
  anything cached across races is invisible to them. A racing-line cache keyed
  on a recycled `Centerline*` once made bots drive the previous track's line;
  `race_isolation`, `catalogue_sweep` and `replay_sequence` exist to catch that
  class.
- Our own code carries `-Wall -Wextra` (`ttp_warnings`); the vendored fdlibm and
  double-conversion deliberately do not.
