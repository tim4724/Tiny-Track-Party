# native/ — the C++ engine

Compiles to wasm for the web and to native libraries for tvOS and Android TV. The
root `CLAUDE.md` holds the rules that outrank anything local; this file covers how
the C++ is layered and what a shell may and may not do.

## Layering

`libttp-sim` (car sim, AI, items), `libttp-track` (track builder, schematic
codec), `libttp-party` (room state, framing, netcode, session policy),
`libttp-runtime` (the platform-free decision layers), `renderer` (Filament),
`libttp-json` (shared JSON, ships inside the ABIs), `testsupport` (corpus diffing,
test-only and never linked into a shipped ABI).

Two linkage constraints, both load-bearing:

- **libttp-runtime has no edge on libttp-party.** Where it needs one of the party
  layer's types it MIRRORS the declaration, and a ctest pins the copy to the
  original. The mirror plus its gate is cheaper than the dependency.
- **libttp-runtime and the renderer may not link each other.** Anything both need
  is `inline` in a header both include; `boost_shades` in libttp-runtime's
  `theme.h` is the worked example. It exists because the renderer had drifted its
  own copy of the mixer, so **do not re-derive a shade** — the frozen theme corpus
  pins them.

## The ABI boundary (`runtime/`)

Exports come from `TTP_ABI` on each declaration in the public headers; there is no
export list to maintain. The C ABI is not on the replay path, so the `abi` ctest
covers this marshalling layer — see `tests/CLAUDE.md`.

**Returns are canonical JSON (key-sorted)** except `ttp_ui.h` and `ttp_net.h`,
which return the model's own key order. That order is **not** a wire guarantee:
every outbound frame is canonicalized before it leaves, so phones always receive
sorted keys. It earns its keep only at the ABI boundary, where the `abi` ctest asserts
exact bytes against corpora recorded from a JS oracle. Do not spend anything
defending a key order the wire discards.

**JSON or packed? Answer by call frequency.** A layer answering once per event
returns JSON, especially when half its answer is unbounded text. A layer drained
per frame returns a packed block. The HUD and audio ABIs are the packed
precedent; ui and session are the JSON one.

**A JSON-taking spelling stays** even after a handle-taking twin exists: the JSON
forms are what the frozen corpora replay, and a corpus carries a synthetic world
with no room machine behind it. The JSON form is the conformance surface; the
handle form is what ships.

**Not every C++ entry point is exported.** The item, rocket and car-stat mutators
are reachable only from `replay_cli`, which calls C++ directly. A scenario needing
them cannot be driven from JS or wasm — write it in C++ rather than hunting for
the export.

## Seams: cross-layer reads happen in C++

`runtime/ttp_session.h` and `runtime/ttp_room.h` are **internal headers, not
ABIs**. An ABI shim links sim, party and runtime, so when one layer's answer needs
another layer's state the read happens here rather than through JS. That replaced
the shell as courier, where two C++ functions reached each other through a
serialize/parse round trip on every publish.

**The cost is the chooser payload, not the roster** — an immutable blob set once
at boot that the round trip re-parsed on every join, rename, pick and ready
toggle. Node microbenchmarks under-read this badly because a hand-built snapshot
has no chooser in it: **measure a publish path in the page with the real payload,
or do not quote a number.**

**A handle form is gated differently**, because no corpus can cover it. It adds no
rule, it only GATHERS what a shell used to gather, so the only statement of
correctness is byte-for-byte agreement with the two-call path. The `abi` ctest
computes the expected value the old way in the same run, never a second copy of
the wire format. **Add a case there for every new handle-taking export** — the
handle-taking exports and their JSON twins are `ttp_room_sync_active_order`,
`ttp_net_lobby_frame` and `ttp_ui_roster_seats_room_json`.

## Platform shells

`runtime/ttp_display_web.cc` is the WEB shell and needs the Filament SDK, so it
compiles on one machine configuration and **no ctest sees it**. tvOS and Android
TV get siblings of that file, not of the library.

**If a line names no platform API it belongs in libttp-runtime**, where ctests
compile and execute it on every leg. Anything that must not drift silently goes in
the library, never in the shim.

What a sibling shell compiles alongside its own file is `TTP_APP_SOURCES` — one
variable, because a second target retyping the list would drift on the first ABI
added and fail as a link error on one platform only.

`docs/native-port/shells.md` is the audited ledger of what a new platform owes.

## Shared headers

A boundary reads JSON with `libttp-json/ttp/json_read.h` (note `truthy` — JS
truthiness, not a bool test); a conformance check uses `testsupport/corpus_diff.h`.
Both exist because the hand-copied versions had already drifted once. **A new ABI
or check writes neither: it includes them.**

## The track builder

No JS twin. `ttp_display_build` runs the builder itself, so the renderer meshes
from the same track the sim races on: the browser holds no geometry and **nothing
about a scene is serialized**. The roster crosses as an argument with a single
reader, so livery encoding and name-plate data are written once for three shells
rather than once per shell.

The projection behind the schematic bake rounds through JS `toFixed`, which printf
cannot reproduce — it routes through double-conversion's `ToFixed` (V8's own).

Node reads geometry through `scripts/native-track.mjs` over the shipped wasm.

## Building

`native/scripts/build-runtime-web.sh` builds the engine and needs the Filament
fork plus emsdk, both fetched on first run. CMake only adds the renderer under
`-DFILAMENT_SDK`, which CI lacks — so CI's wasm leg link-checks the browser ABI
against a sim-only build of the same target.

Rebuild and commit the artifacts after touching anything here (root rule 6);
`node native/scripts/runtime-source-hash.mjs --files` lists what is hashed.

**Rebuilds are cheap across worktrees only because of `CCACHE_BASEDIR` /
`CCACHE_NOHASHDIR`**, which the CMake sets. Without them ccache hashes the
absolute source path, two worktrees share nothing, and the cache becomes pure
overhead. A ccache-populated build reproduces the committed wasm byte for byte,
which is what makes `basedir` acceptable in a tree this conformance-bound. Ninja
is chosen on a fresh build dir and is then fixed for that directory's life.

Material compilation lives in `native/scripts/build-materials.sh`, **shared on
purpose** so other platform legs inherit it. It is mtime-gated on the `.mat`
sources and on `matc`, so editing a material and seeing nothing rebuild means the
gate decided it was current, not that the build is broken.

## Warnings

Our own code carries `-Wall -Wextra`; the vendored fdlibm and double-conversion
deliberately do not, being taken whole from upstream. **Not `-Werror`** — a newer
compiler's new diagnostic must not block a build. The strict-FP flags on the sim
targets are the determinism contract (root rule 5).

## Balance probes

`npm run probe:cars` / `probe:laptime` / `probe:difficulty` drive `probe_cli`. The
old JS probes ran the AI with no game context and unseeded items, so **readings
from before the native probe are not comparable.** The probe is a tuning
instrument, not a gate, but `probe_smoke` keeps it from rotting — it is what
surfaced the racing-line bug, as lap times that moved between identical sweeps.
