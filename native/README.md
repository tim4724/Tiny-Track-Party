# native/

The C++ engine. The sim, the track builder, the cup series, the party layer's
decisions, the UI model, the audio decisions and the renderer all run here —
compiled to WebAssembly for the browser, and natively for the TV shells. There is
no JS engine to fall back on.

**The rules for working in here are `native/CLAUDE.md`** — layering, the ABI
conventions, the seams, the determinism contract, and what a platform shell may
and may not do. This file is orientation only.

`docs/native-port/` holds two kinds of document, and mistaking one for the other
wastes an afternoon. Only the ledger is audited against the tree:

| | |
|---|---|
| [shells.md](../docs/native-port/shells.md) | **Live.** What a new platform still owes, audited against the tree and dated. Start here for shell work. |
| [architecture.md](../docs/native-port/architecture.md) | **Decision record.** Why the stack is what it is. Stable, not a status board. |
| [contract.md](../docs/native-port/contract.md) | **Contract + provenance.** The data shapes are current; every JS `file:line` in it cites a retired source. |
| [fp-profile.md](../docs/native-port/fp-profile.md) | **Provenance.** Why each bit-exactness rule exists, cited to JS that no longer exists. Its §7 gate table is the one part describing today. |
| [plan.md](../docs/native-port/plan.md), [shared-cpp-plan.md](../docs/native-port/shared-cpp-plan.md) | **Plans.** Per-track state lives in their own headings; the tree is what was actually built. |

The retired JS engine and its recorders are reachable through
`npm run revive:js-oracle`, which restores them into a throwaway worktree. That is
an archaeology and corpus-re-derivation tool, not a gate: what gates the port
TODAY is the ctest suite.

## Layout

```
libttp-sim/     Game (physics/items/ranking), AiDriver, RaceSession, GrandPrix.
libttp-track/   Vec3, Centerline, TrackBuilder, the schematic codec.
                generated/track_defs.h carries the shipped layouts.
libttp-party/   RoomFlow, relay framing, fastlane netcode, session policy.
                Sans-IO: the host owns the socket and the RTCPeerConnection.
libttp-runtime/ The platform-free decision layers: chase and overview cameras,
                the framing solve, the per-frame TtpFrameInput built straight
                off the live Game, plus the ui model, race orchestration, audio
                decisions and the biome theme. Where the sim and the renderer
                MEET, so no frame state is ever serialized to the shell. Every
                leg compiles AND runs it.
renderer/       The Filament renderer. include/ttp_render.h is its INPUT
                CONTRACT (TtpFrameInput), an internal C++ header rather than an
                ABI. Built only when -DFILAMENT_SDK points at the fork's wasm
                install of the commit in native/filament.pin (which
                carries the tvOS port + the newer-clang fixes). A BRANCH NAME
                here went stale twice — the pin is the one durable answer.
libttp-json/    Canonical JSON (sorted keys, ECMA-262 shortest-form numbers)
                + the parser. Byte-identical to JSON.stringify by contract.
runtime/        The public C ABIs — sim, party, display, ui, net, race, audio,
                theme — plus the internal seam headers. No C++ types cross them.
                ttp_display_core.cc is the display ABI's shared bodies;
                ttp_display_web.cc is only the WEB surface (the WebGL2
                context), and tvOS/Android get siblings of that surface file
                alone — never of the core or the library.
mathlib/        Vendored fdlibm — transcendentals off V8's implementation, so
                traces are platform-independent.
replay/         replay_cli — the golden-trace conformance gate.
probe/          probe_cli — the balance instruments (lap times, car matrix).
*test/          ctest suites, one per library plus the ABI.
```

## Build and test

```bash
npm run test:native                    # build + the whole suite, in parallel
npm run test:native -- -R raceflow     # one ctest by name; `ctest -N` lists them
```

Prefer those over raw `ctest`, which runs whatever binaries are already there —
so forgetting the build is a green suite that says nothing — and is serial by
default. By hand, if you want the pieces:

```bash
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/build -j8
ctest --test-dir native/build -j8
```

The browser artifacts are **checked in**, so after touching anything here rebuild
and commit them:

```bash
native/scripts/build-runtime-web.sh    # -> public/display/engine/native/
```
