# public/assets/audio/ — the audio files are ARTIFACTS

Three kinds, with different sources. None is hand-edited.

## Cues are GENERATED

`display/audio/cues.js` is the source; the WAVs under `cues/` are what
`scripts/bake-cues.mjs` renders from it. Change the DSP, re-bake, commit.

**Re-baking is MANUAL and nothing in CI does it** — it needs Playwright, a dev
server and headless Chromium, and the output is a checked-in artifact like the
wasm. What CI does instead is notice: `tests/bake-cues.test.js` fingerprints the
shared prelude and every picked variant, so editing `cues.js` without re-baking
turns the unit job red naming the cue. Trust that gate rather than remembering.

`npm run bake:cues -- --check` re-renders in a real browser and diffs, and is the
only thing that proves the committed PCM is what `cues.js` renders TODAY. It is
deliberately not in CI: a re-bake lands within 1 LSB rather than on the byte
(Chromium sums a node's fan-in in heap-address order), and that tolerance is
calibrated per machine, so a runner's Chromium could fail it without anything
having drifted.

## Recorded sources are INPUTS, not output

`engine_loop.ogg` and the `sfx/` one-shots are third-party licensed recordings —
the bake consumes the engine loop rather than synthesising it. Each ships beside
its `*.LICENSE.txt`, which is **part of the asset**: never prune one as an
unreferenced file.

**Attribution is a licence obligation, not a nicety.** The catalogue is CC-BY, so
`music/CREDITS.txt` and the fields `tests/credits.test.js` guards are load-bearing:
missing attribution is a licence violation, not a cosmetic bug.

## Music is ACQUIRED, so its source is a URL

The shipped mp3s are downloads re-encoded to a lower bitrate. The masters are
deliberately **not** in the tree — a checked-in master would be a backup, not a
generator, and git already has one.

What stands in for them is `music/SOURCES.json` (per song: download URL, master
sha256, byte count) plus the recorded encode. `npm run fetch:music` rebuilds every
shipped file from scratch; `--verify` just re-checks the hashes.

**Always re-encode from the masters, which is why that script insists on the
download.** Running a lower setting over the SHIPPED files is lossy-to-lossy: the
encoder spends bits reproducing the last encoder's artifacts, and the catalogue
can come out larger than it went in.

The web streams one song at a time through an `<audio>` element. **Both TV shells
bundle the whole catalogue** and fall back to the origin only when a build staged
none of it, so the size is paid by the deploy image, every clone, and two app
bundles. `SOURCES.json`'s `note` carries the bitrate reasoning; the short version
is that the setting below the current one deletes everything above 15 kHz and no
gate in this tree would tell you.

## MP3 is not a quality choice here

This is the trap. Opus/AAC at low bitrates are smaller and better per bit, **but**
the C++ song table bakes the path INCLUDING the extension and the audio corpus
froze those strings — and that corpus can never be re-recorded, because its JS
oracle is deleted.

Changing the extension turns the audio replay and its record roundtrip red on all
four legs. Moving off MP3 means making the song's file field a stem and letting
each shell append its own extension: **an ABI and corpus change, not an encode.**

MP3 also happens to be the only container all four legs decode unaided, which is
what makes the bundling above a copy rather than a pipeline. Apple decodes Opus
only inside CAF — a container ffmpeg cannot mux, so that leg alone would need a
macOS-only `afconvert` step — and `MediaPlayer` reads Ogg Opus only from API 29,
against this app's minSdk 24. A stem would buy three artifacts per song.

Changing the BITRATE is a different question and costs none of that: the
extension is untouched, so nothing in the corpus moves. Only `SOURCES.json`'s
`encode.args` and `npm run check:music-loudness` are involved.

## Re-encode with NO filters

The per-song gains are frozen literals derived from each file's integrated
loudness, so an `-af loudnorm` would silently invalidate the whole trim table —
and the corpus would still pass, because it only knows the literal.

`npm run check:music-loudness` is the only thing in the tree that would notice
(measured LUFS vs the catalogue's, plus the baked duration and a cover-art check).
It shells out to ffmpeg, so it is a script rather than an `npm test` entry. **Run
it after anything that touches these files.**
