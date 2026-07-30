# public/assets/audio/ — the audio files are ARTIFACTS

Three kinds, with different sources. None is hand-edited.

## Cues are GENERATED

`scripts/bake-cues.mjs` is the source; the WAVs under `cues/` are baked from it.
Change the script, re-bake, commit.

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

This is what took `public/assets` down to a fraction of its old size, nearly all
of it the preview deploy image. The songs STREAM one at a time through an
`<audio>` element, so it was never a per-player download cost.

## MP3 is not a quality choice here

This is the trap. Opus/AAC at low bitrates are smaller and better per bit, **but**
the C++ song table bakes the path INCLUDING the extension and the audio corpus
froze those strings — and that corpus can never be re-recorded, because its JS
oracle is deleted.

Changing the extension turns the audio replay and its record roundtrip red on all
four legs. Moving off MP3 means making the song's file field a stem and letting
each shell append its own extension: **an ABI and corpus change, not an encode.**

## Re-encode with NO filters

The per-song gains are frozen literals derived from each file's integrated
loudness, so an `-af loudnorm` would silently invalidate the whole trim table —
and the corpus would still pass, because it only knows the literal.

`npm run check:music-loudness` is the only thing in the tree that would notice
(measured LUFS vs the catalogue's, plus the baked duration and a cover-art check).
It shells out to ffmpeg, so it is a script rather than an `npm test` entry. **Run
it after anything that touches these files.**
