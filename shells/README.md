# Shells

A **shell** is the per-platform half of the game: a surface, a 2D UI in the
platform's own toolkit, a socket, an audio device, and the code that fetches
bytes. [`docs/native-port/architecture.md`](../docs/native-port/architecture.md)
states the rule it lives by — *a shell may only contain code that names a
platform API* — and
[`docs/native-port/shells.md`](../docs/native-port/shells.md) is the audited
ledger of what one owes.

Everything a shell does NOT do is in [`native/`](../native): the sim, the track
math, the renderer, the cameras, the race orchestration, the room and session
policy, the audio decisions and every 2D screen's DECISIONS are one C++
implementation behind a C ABI, conformance-gated on four legs.

| | Shell | Lives in |
|---|---|---|
| Web | `display/` + `controller/` pages | [`public/`](../public) |
| Apple TV | SwiftUI + Metal | [`tvos/`](tvos) |
| Android TV | Compose + GLES3 | not written |

## Why the web shell is not in here

Two reasons, and the second is the load-bearing one.

It is not only a shell. `public/` is the **origin**, and a TV app has none of
its own: the join QR, the controller URL template and the phone controller
itself are all served from there, so the web deployment is a *runtime
dependency* of every TV shell (`shells.md` §8). Moving it under `shells/` would
name it as one implementation among three when it is also the thing the other
two point at.

And the phone stays on the JS controller on all three TV platforms — forever, by
design — so `public/controller/` is not a web-shell detail either. It is the
half of the game that never gets a second implementation, which is why
`tests/wire-compat.test.js` is a permanent gate rather than a migration one.

## The C ABI file is not in here either

Each shell's `extern "C"` bodies — `native/runtime/ttp_display_web.cc`,
`native/runtime/ttp_display_tvos.mm` — sit beside the ABI they implement, not
beside the app that calls them. They are C++ compiled by
`native/CMakeLists.txt` into that platform's module, and they are the *only*
file in the module that differs between platforms (`TTP_APP_SOURCES` is the
rest, shared verbatim). Keeping them together is what makes that difference
readable as a diff.
