# native/

The C++ engine. The sim, the cup-series layer and the party layer's decisions all
run here — compiled to WASM for the browser (and natively for the TV shells).
There is no JS engine to fall back on.

Decision record: [docs/native-port/architecture.md](../docs/native-port/architecture.md).
Sim contract: [docs/native-port/contract.md](../docs/native-port/contract.md).
FP rules: [docs/native-port/fp-profile.md](../docs/native-port/fp-profile.md).

## Layout

```
renderer/       libttp-renderer: platform-free Filament renderer (no platform or
                emscripten includes). Ships identically on web/tvOS/Android.
                include/ttp_render.h is its INPUT CONTRACT (TtpFrameInput), an
                internal C++ header rather than an ABI. Built only when
                -DFILAMENT_SDK points at the fork's wasm install
                (~/Projects/filament, branch tvos-v1.74.0, which carries the
                tvOS port + newer-clang fixes).
libttp-track/   Vec3, Centerline, TrackBuilder, JS-parity math shims.
                generated/track_defs.h carries the 20 shipped layouts.
libttp-sim/     Game (physics/items/ranking), AiDriver, RaceSession, GrandPrix.
libttp-json/    Canonical JSON (sorted keys, ECMA-262 shortest-form numbers)
                + the parser. Byte-identical to JSON.stringify by contract.
libttp-party/   RoomFlow, relay framing, fastlane netcode. Sans-IO: the host
                owns the socket and the RTCPeerConnection.
libttp-runtime/ The platform-free half of the display runtime: the chase and
                overview cameras, the framing/fog solve, and the per-frame
                TtpFrameInput built straight off the live Game. This is where
                the sim and the renderer MEET, so no frame state is ever
                serialized to the shell. No Filament, no emscripten, no
                platform API — every leg compiles it AND runs it, via the
                runtime_check (cameras/framing/grid) and frame_builder
                (the per-frame assembly) ctests.
runtime/        The three public C ABIs: ttp_runtime.h (sim), ttp_party.h
                (party) and ttp_display.h (surface, scene, cameras, frame).
                No C++ types cross them. ttp_display_web.cc is the WEB shell
                behind the third: the WebGL2 surface and the TtpRenderer calls
                and nothing else, built only with -DFILAMENT_SDK. tvOS and
                Android get siblings of that file, not of the library.
mathlib/        Vendored fdlibm — transcendentals off V8's implementation, so
                traces are platform-independent.
replay/         replay_cli — the golden-trace conformance gate.
probe/          probe_cli — the balance instruments (lap times, car matrix).
*test/          ctest suites, one per library plus the ABI.
```

## Build and test

```bash
npm run test:native                      # build + the whole suite, in parallel
npm run test:native -- -R raceflow        # one test
```

That is the two commands below with the two edges taken off — `ctest` runs
whatever binaries are already there, so forgetting the build is a green suite
that says nothing, and it is serial by default (6.2 s against 2.4 s at `-j`).
By hand, if you want the pieces:

```bash
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/build -j8
ctest --test-dir native/build -j8
```

(No test count here on purpose. It was written down as 36 for a 48-test suite;
`ctest -N` will tell you, and `npm run setup` prints it.)

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
