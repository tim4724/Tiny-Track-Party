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

## Attribution is data, and it derives

`credits.js` is every third-party thing that SHIPS, and `/licenses.html` renders
it. Two rules make the page unable to lie. The songs are not listed: they come
out of the live music catalogue, so a change to the picks cannot leave one
uncredited. And a license's OBLIGATION — whether the credit is the license
condition (CC-BY), whether the license text has to ship, or whether nothing is
owed — is looked up from the license id, never typed per entry, so nothing can
claim a lighter duty than it is under. Adding a dependency under a license the
table has not seen fails `tests/credits.test.js` rather than rendering blank.

Where a license needs its text to travel with the build, the entry's `notice`
points at a copy this site SERVES, and that copy is what the license chip links;
a link upstream does not discharge it. So `notice` belongs on exactly the
entries whose license demands one, both ways round — one on a CC0 entry sends a
reader to a file nothing obliged us to ship, and used to make two works under
the same license show different links. The two vendored C libraries' notices are
copies under `public/assets/licenses/`, held byte-equal to `native/vendor/` by
the same test.

**The page rots by the build moving under it, not by anyone editing it**, so
each entry's `covers` names what it accounts for in the tree and the census in
`tests/credits.test.js` reads both directions: a `covers` path that is gone
means the credit outlived the thing it describes, and a third-party surface no
`covers` names means something ships uncredited. Surfaces are discovered from
what the tree already maintains for its own reasons — an asset arrives with its
license file, vendored C sits in `native/vendor/`, vendored browser JS is what
eslint refuses to lint, npm runtime deps ship with the server — never from a
second list that could rot in its own right. Anything baked in from a PINNED
upstream (Filament, Emscripten) has no path here and is undiscoverable by
construction; `assets/licenses/SOURCES.md` carries the obligation to re-fetch
those when the pin moves, and that is the one part still resting on prose.

The page groups by TYPE, and `SECTION_ORDER` is the list of types there are —
so an entry in a section missing from it would be dropped off the page in
silence. Add the section there when you add the entry; the same test catches it.

## The schematic codec

`schematicCodec.js` is the pack/unpack pair, **shared because the PHONE unpacks** —
phones stay on the JS controller on all three TV platforms, so that half is
permanent browser code with no native twin.

The projection half is retired. The bake is native now:
`scripts/gen-track-schematics.js` reads it out of the wasm and reproduces the
committed `trackSchematics.js` BYTE-IDENTICALLY, which is why the historical key
order is respelled on the Node side.

## The join QR

`qr.js` encodes the join URL **in the browser** — there is no server endpoint and
no C++ encoder, and why is `docs/native-port/shells.md` §7. It owns the encoding
policy the other shells reimplement, so its EC level and quiet zone are asserted
structurally rather than left to prose.

`qrcode-generator.js` under it is vendored verbatim, hence lint-ignored: leave
upstream's style alone and keep its MIT notice, which is how that licence ships.

## biomes.js and the track descriptors

`biomes.js` is the browser's whole edge of the native palette; what may be added to
it is in `native/libttp-runtime/CLAUDE.md`.

`tracks.js` / `devTracks.js` are authored DESCRIPTORS and JS by design,
codegen'd into the wasm. Nothing on the display page imports `tracks.js` any more —
the shipped catalogue is read back out of the wasm.
