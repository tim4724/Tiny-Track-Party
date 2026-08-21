# Where these texts came from

The third-party code that ships in the APK and NOWHERE ELSE in this tree. The
browser supplies its own socket, its own QR encoder and its own widgets, so none
of these has a home under `public/assets/licenses/` (whose contents
`tests/credits.test.js` pins exactly).

Most of it is Apache-2.0, and Apache-2.0 §4(a) is discharged by a copy of the
license travelling with the build — the per-project COPYRIGHT is on the board's
row, which is where `author` comes from. So there are fewer texts here than
artifacts: the projects whose LICENSE file is not the canonical Apache text keep
their own, and everything whose LICENSE is byte-identical to apache.org's shares
that one file.

| File | Copied from | Covers |
|---|---|---|
| `apache-2.0-LICENSE.txt` | <https://www.apache.org/licenses/LICENSE-2.0.txt> | OkHttp, Okio, the Kotlin standard library — each project's own `LICENSE.txt` is byte-identical to this |
| `androidx-LICENSE.txt` | `LICENSE.txt` at the root of androidx/androidx | AndroidX and Jetpack Compose (the terms without apache.org's appendix) |
| `zxing-LICENSE.txt` | `LICENSE` at the root of zxing/zxing | ZXing (the Apache terms plus its Sun/JAI addendum) |
| `webrtc-LICENSE.txt` | `LICENSE` at the root of webrtc.googlesource.com/src, then `LICENSE` at the root of webrtc-sdk/android | the fastlane's prebuilt libwebrtc |

**The WebRTC entry is TWO texts in one file, and the split is the point.** The
library is BSD-3-Clause and the distribution that builds it is MIT, and the AAR
ships NEITHER — it carries no license file at all, which is what makes
reproducing them entirely ours to do. The first half is byte-identical to
`shells/tvos/.../Licenses/LiveKitWebRTC-LICENSE.txt`, because it is the same
upstream: two shells link two builds of one library, so the row says "WebRTC"
on both and the notice is the same 1511 bytes.

Re-copy on a version bump; a license text is only a notice while it is intact,
so nothing may reformat or truncate one. `shells/androidtv/scripts/gen-legal.mjs`
lists the packages beside the shared credits, and `tests/androidtv-legal.test.js`
fails if a declared Gradle dependency has no credit, if a credit has no text, or
if a text stops reading as the license it stands in for.
