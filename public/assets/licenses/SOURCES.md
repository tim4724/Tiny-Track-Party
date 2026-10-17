# Served license texts

Verbatim copies, **never edited** — an edited license text is not the license.
They are here because permissive licenses require their text to travel with the
distribution, and a link to someone else's server does not do that. Each is
linked from `/licenses.html` as an entry's `notice` (see `shared/credits.js`).

| File | Covers | Comes from |
|---|---|---|
| `openlibm-LICENSE.md` | the deterministic maths in the wasm | `native/vendor/fdlibm/LICENSE.md` |
| `double-conversion-LICENSE.txt` | number formatting in the wasm | `native/vendor/double-conversion/LICENSE` |
| `meshoptimizer-LICENSE.txt` | the far-form simplifier in the renderer | `native/vendor/meshoptimizer/LICENSE` |
| `qrcode-generator-LICENSE.txt` | the join-code QR encoder vendored at `shared/qrcode-generator.js` | the `LICENSE` of `kazuhikoarase/qrcode-generator` |
| `filament-LICENSE.txt` | the renderer in the wasm | the `LICENSE` of the fork commit in `native/filament.pin` |
| `filament-third-party-LICENSES.txt` | the third-party code Filament compiles into the engine: one text per library | `third_party/<lib>/LICENSE` in that same checkout, the set listed in `scripts/gen-upstream-licenses.mjs` |
| `emscripten-LICENSE.txt` | the wasm glue the toolchain emits | the `LICENSE` of the emsdk version pinned in `native/scripts/build-runtime-web.sh` |
| `musl-COPYRIGHT.txt` | the C library Emscripten links into the wasm | `system/lib/libc/musl/COPYRIGHT` in that same emsdk |

The first three have a copy in this tree, and `tests/credits.test.js` holds them
byte-equal to it. The last four are **derived, never fetched by hand**:
`scripts/gen-upstream-licenses.mjs` reads them out of the pinned Filament
checkout and the installed emsdk, `native/scripts/build-runtime-web.sh` runs it
after both exist, so moving either pin regenerates them in the same commit, and
the same test diffs the served copies against that derivation on any machine
that has the checkouts. The bundle's texts are verbatim; only the rules between
them, naming which library each belongs to, are ours.

The QR one is the last fetched text, with a weaker but real guard: the test
requires the copyright line in the served text to appear in the vendored
`shared/qrcode-generator.js`, so swapping the encoder for another cannot leave
the old author's notice behind. That is exactly what happened when the encoding
moved off the server — the page served node-qrcode's notice for code that no
longer shipped.

```sh
curl -sfL -o public/assets/licenses/qrcode-generator-LICENSE.txt \
  "https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/master/LICENSE"
```

Adding a dependency under a license that requires a notice means adding its text
here too — the test names the entry that lacks one rather than letting the page
claim a notice that isn't served.
