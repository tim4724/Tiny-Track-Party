# Served license texts

Verbatim copies, **never edited** — an edited license text is not the license.
They are here because permissive licenses require their text to travel with the
distribution, and a link to someone else's server does not do that. Each is
linked from `/licenses.html` as an entry's `notice` (see `shared/credits.js`).

| File | Covers | Comes from |
|---|---|---|
| `openlibm-LICENSE.md` | the deterministic maths in the wasm | `native/vendor/fdlibm/LICENSE.md` |
| `double-conversion-LICENSE.txt` | number formatting in the wasm | `native/vendor/double-conversion/LICENSE` |
| `qrcode-generator-LICENSE.txt` | the join-code QR encoder vendored at `shared/qrcode-generator.js` | the `LICENSE` of `kazuhikoarase/qrcode-generator` |
| `filament-LICENSE.txt` | the renderer in the wasm | the `LICENSE` of the fork commit in `native/filament.pin` |
| `emscripten-LICENSE.txt` | the wasm glue the toolchain emits | the `LICENSE` of the emsdk version pinned in `native/scripts/build-runtime-web.sh` |

The first two have a copy in this tree, and `tests/credits.test.js` holds them
byte-equal to it. The rest are fetched from upstream — nothing can diff those,
so **re-fetch them when you move the pin or re-vendor**:

```sh
curl -sfL -o public/assets/licenses/filament-LICENSE.txt \
  "https://raw.githubusercontent.com/tim4724/filament/<FILAMENT_COMMIT>/LICENSE"
curl -sfL -o public/assets/licenses/emscripten-LICENSE.txt \
  "https://raw.githubusercontent.com/emscripten-core/emscripten/<EMSDK_VERSION>/LICENSE"
curl -sfL -o public/assets/licenses/qrcode-generator-LICENSE.txt \
  "https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/master/LICENSE"
```

The QR one has a weaker but real guard: the test requires the copyright line in
the served text to appear in the vendored `shared/qrcode-generator.js`, so
swapping the encoder for another cannot leave the old author's notice behind.
That is exactly what happened when the encoding moved off the server — the page
served node-qrcode's notice for code that no longer shipped.

Adding a dependency under a license that requires a notice means adding its text
here too — the test names the entry that lacks one rather than letting the page
claim a notice that isn't served.
