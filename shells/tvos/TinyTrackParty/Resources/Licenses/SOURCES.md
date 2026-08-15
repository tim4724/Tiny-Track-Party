# Where these texts came from

The two third-party components that ship in the tvOS app and NOWHERE ELSE in
this tree: the web display uses the browser's own WebRTC and rasterizes the item
SVGs in the DOM, so neither has a home under `public/assets/licenses/` (whose
contents `tests/credits.test.js` pins exactly).

Both are copied VERBATIM from the pinned package, at the version
`shells/tvos/project.yml` names. Re-copy on a version bump; a license text is
only a notice while it is intact, so nothing may reformat or truncate one.

| File | Copied from | License |
|---|---|---|
| `SwiftDraw-LICENSE.txt` | `LICENSE.txt` at the root of swhitty/SwiftDraw | zlib |
| `LiveKitWebRTC-LICENSE.txt` | `LICENSE` inside livekit/webrtc-xcframework's `LiveKitWebRTC.xcframework` | BSD-3-Clause |

`shells/tvos/scripts/gen-legal.mjs` lists them beside the shared credits, and
`tests/tvos-legal.test.js` fails if a package here has no text, or if a text
stops reading as the license it stands in for.
