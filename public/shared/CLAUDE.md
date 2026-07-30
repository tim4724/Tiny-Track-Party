# public/shared/ — the contracts both ends read

Imported by the display AND the controller, and some of it by Node. Modules Node
imports via dynamic `import()` must stay **dependency-free** so they load in both.

**This is where shared code goes, and the reason is structural:**
`public/display/` is what the tvOS and Android shells REPLACE, so nothing the
controller needs may live there. A controller importing from `display/` silently
couples the phone to a directory two other platforms delete.

## protocol.js is the manifest

It holds the relay/STUN URLs and the message vocabulary — game-side config,
injected into the partyplug kit at construction, since the kit reads no game
globals.

It is also **the manifest for every number two layers share**: the car tables, the
tilt→steer contract split across the sim and the phone and the wire gate, the
presence contract split across the phone's ping and the display's windows, and
whatever arrives later. Read the file for the current set; the point is the rule,
not the list.

Two worked examples of why things land here. "A seat silent past N seconds is
dropped" is only true against a matching ping rate, and those two numbers used to
live in two files with a prose comment between them. The display's own heartbeat
message was a bare literal inside its net module, so a TV shell reimplementing that
liveness had nothing to copy.

**Nothing may re-declare a manifest number silently, and a new shared number is
added HERE first.**

`tests/config-drift.test.js` pins the phone and display modules to it, re-runs the
input gate's dead-band derivation, checks the presence windows still describe one
design, and reads the steer expo back out of the shipped wasm.

**The third source, and the only one.** A shell that can read neither file calls
`ttp_protocol_manifest_json()`. A Kotlin/JNI shell can include no C++ header and
import no ES module, so without it every TV shell would hand-copy the car tables
and the tilt numbers — the exact drift this rule exists to stop. The web
deliberately does not call it, protocol.js being the authored source and already
on the page.

`config-drift` deep-equals that export against the WHOLE of protocol.js, which is
**the one assertion in the tree that catches a constant added to protocol.js and
forgotten everywhere else.**

## Transport wiring

Game events flow over the WebSocket relay; controller input rides the WebRTC
fastlane when its DataChannel is open and falls back to the relay otherwise. The
wiring lives in `GameNet.js`, with the display opening it as the input sink and the
controller enqueuing over it.

**The lobby roster is not a fanout.** The display publishes it as the relay's
retained host snapshot, pushed live to controllers and replayed to each (re)joiner
right after they join.

## Design tokens are DATA as well as CSS

`theme.css`'s `:root` stays the authored source; `scripts/gen-design-tokens.mjs`
bakes it to `design-tokens.json` — typed, aliases resolved — for the TV shells that
need a second implementation of the sticker look.
`tests/design-tokens.test.js` proves the bake faithful via an independent scrape
and enforces two rules the CSS can only state in prose: the button sink must be
less than its drop, and chrome roles must resolve to chrome colours only.

The theme itself, and which colours are vetoed, is in the root `CLAUDE.md`.

## The schematic codec

`schematicCodec.js` is the pack/unpack pair, **shared because the PHONE unpacks** —
phones stay on the JS controller on all three TV platforms, so that half is
permanent browser code with no native twin.

The projection half is retired. The bake is native now:
`scripts/gen-track-schematics.js` reads it out of the wasm and reproduces the
committed `trackSchematics.js` BYTE-IDENTICALLY, which is why the historical key
order is respelled on the Node side.

## biomes.js and the track descriptors

`biomes.js` is the browser's whole edge of the native palette; what may be added to
it is in `native/libttp-runtime/CLAUDE.md`.

`tracks.js` / `devTracks.js` are authored DESCRIPTORS and JS by design,
codegen'd into the wasm. Nothing on the display page imports `tracks.js` any more —
the shipped catalogue is read back out of the wasm.
