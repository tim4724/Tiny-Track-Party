// musicCatalogue.js — the race music, as DATA.
//
// WHAT IT IS. Each track's song, each song's authored loudness trim, the
// fallback pool and the bed level. Nothing here decides anything: WHICH song a
// race gets, at what gain, is the audio DECISION layer's, and that layer is C++
// (native/libttp-runtime/ttp/audio.cc, reached through ttp_audio.h). A picked
// song crosses back as an INDEX into TRACK_MUSIC and is resolved once per race.
//
// WHY IT IS ITS OWN FILE. It used to live inside public/display/audio/decide.js,
// which was the JS oracle the audio corpus was recorded off. Everything that
// needed the catalogue — the music gallery, tests/credits.test.js,
// tests/display-abi.test.js — therefore imported the ORACLE to get at a table,
// which is what kept a retired decision layer on the shipped page's import
// graph. When decide.js was retired the catalogue had nowhere to fall back to,
// so it moved here: the data outlives the layer that read it, and always would
// have.
//
// (Audio.js used to re-export these four for the same consumers. It does not:
// the device half holds no table at all, and even the monster engine's timbre
// arrives as numbers on a voice command.)
//
// KEEP IT IMPORT-FREE. Node loads this directly (the credits test), so
// CLAUDE.md's dependency-free rule applies.

// attribution for Kevin MacLeod's tracks (see music/CREDITS.txt). duration = whole
// seconds, baked so galleries can show a song's length without loading its
// metadata (the race itself never reads it).

// `source` is the collection page, not a per-song one, and that is as specific
// as it gets: incompetech renders its catalogue client-side, so there is no
// per-track URL to link (the ?isrc= form serves the same generic shell). The
// per-song MASTER download is recorded in assets/audio/music/SOURCES.json,
// which is where provenance lives — it is a 5 MB file, not a page to send a
// reader to.
export const MACLEOD = {
  artist: 'Kevin MacLeod',
  license: 'CC-BY 4.0',
  source: 'https://incompetech.com/music/royalty-free/music.html',
};
// lufs = the file's integrated EBU R128 loudness, measured once at wiring time:
//   ffmpeg -i song.mp3 -map 0:a -filter ebur128=framelog=quiet -f null -
// (read the summary's "I:" line). The catalogue is mastered all over the place
// (-19.1 .. -9.2 LUFS as shipped — the hottest song lands >2x as loud as the
// quietest), so each song carries a gain trimming it to a common target and
// every pick sits at the same perceived level. The target sits just under the
// quietest pick so gains stay ≤ 1 (safe for plain el.volume routing); if a new
// pick measures quieter, lower the target and raise MUSIC_LEVEL by the same dB
// (the credits test pins gain ≤ 1 so a too-quiet pick fails loudly).
export const MUSIC_TARGET_LUFS = -19.2;
// `gain` is an AUTHORED LITERAL, not `10 ** ((MUSIC_TARGET_LUFS - lufs) / 20)`
// evaluated here, and that is deliberate. `**` on doubles is V8's pow — the same
// implementation-approximated builtin fp-profile.md §2 keeps off the byte path —
// and this number is recorded into audio-corpus.jsonl as the music `gain`/`level`,
// which the C++ port of P7 must reproduce to the bit. Measured against the vendored
// fdlibm the port actually links: `ttp_fd_pow(10, x)` disagreed with V8's `10 ** x`
// on 2 of the 23 distinct trims when the table was frozen, so deriving the number
// at load time would hand the port songs it could never match.
// A decimal literal has no such problem: JS and C++ both parse it correctly
// rounded, so both get the identical double.
//
// The values ARE that formula's output, kept to the last bit, so nothing about the
// mix changed when they were frozen. `lufs` stays beside each one as the authored
// measurement and the reason for the number, and tests/credits.test.js re-runs the
// derivation over every row to a few-ULP tolerance — so a mistyped literal or a new
// song with a stale trim fails loudly, without the gate resting on V8's pow.
// ADDING A SONG: measure its LUFS, then take the literal from
//   node -e "console.log(10 ** ((-19.2 - <lufs>) / 20))"
const song = (file, title, duration, lufs, gain, credit = MACLEOD) => ({
  // Root-absolute ON PURPOSE, unlike every other asset reference (which goes
  // through shared/assetUrl.js): this string is CANONICAL DATA, mirrored
  // bit-for-bit in the C++ audio layer's table (tests/audio-abi.test.js pins
  // the two equal), and the wasm hands it back in the music-start descriptor.
  // The device edge (Audio.js) resolves it to a real URL at .src time.
  file: `/assets/audio/music/${file}`,
  title,
  duration,
  lufs,
  gain,
  ...credit,
});
// ONE SONG PER TRACK, picked by ear track by track, in catalogue order — the
// order the wasm's song indices count in (tests/audio-abi.test.js pins the two
// tables equal, row for row, and every catalogue track to its own song).
export const TRACK_MUSIC = {
  tidepool: song('island_meet_and_greet.mp3', 'Island Meet and Greet', 217, -13.6, 0.5248074602497727),
  cove: song('arroz_con_pollo.mp3', 'Arroz Con Pollo', 162, -13.2, 0.5011872336272722),
  driftwood: song('spy_groove.mp3', 'Spy Groove', 181, -12.5, 0.46238102139926035),
  riptide: song('beachfront_celebration.mp3', 'Beachfront Celebration', 187, -9.2, 0.31622776601683794),
  powder: song('digital_lemonade.mp3', 'Digital Lemonade', 180, -14.0, 0.5495408738576246),
  flurry: song('new_friendly.mp3', 'New Friendly', 169, -15.7, 0.6683439175686147),
  glacier: song('glitter_blast.mp3', 'Glitter Blast', 178, -15.1, 0.6237348354824193),
  avalanche: song('cloud_dancer.mp3', 'Cloud Dancer', 220, -13.6, 0.5248074602497727),
  ribbon: song('hyperfun.mp3', 'Hyperfun', 233, -19.1, 0.9885530946569391),
  pretzel: song('feelin_good.mp3', 'Feelin Good', 225, -18.0, 0.8709635899560807),
  tangle: song('vivacity.mp3', 'Vivacity', 232, -12.8, 0.4786300923226384),
  cloverleaf: song('happy_happy_game_show.mp3', 'Happy Happy Game Show', 158, -9.7, 0.33496543915782767),
  wash: song('still_pickin.mp3', 'Still Pickin', 298, -13.9, 0.5432503314924333),
  gulch: song('surf_shimmy.mp3', 'Surf Shimmy', 123, -13.4, 0.5128613839913649),
  crag: song('bama_country.mp3', 'Bama Country', 212, -18.2, 0.8912509381337456),
  sidewinder: song('desert_of_lost_souls.mp3', 'Desert of Lost Souls', 181, -16.7, 0.7498942093324559),
  skysnake: song('bit_shift.mp3', 'Bit Shift', 192, -13.3, 0.5069907082747045),
  skyline: song('delightful_d.mp3', 'Delightful D', 184, -10.3, 0.35892193464500527),
  helix: song('itty_bitty_8_bit.mp3', 'Itty Bitty 8 Bit', 194, -11.9, 0.4315190768277653),
  gauntlet: song('master_of_the_feast.mp3', 'Master of the Feast', 228, -15.8, 0.6760829753919819),
};
// A track with no song of its own (the dev tracks) plays one of these instead,
// never silence: the Snow Cup's four, what is left of the old snow pool.
export const MUSIC_FALLBACK = [TRACK_MUSIC.flurry, TRACK_MUSIC.glacier, TRACK_MUSIC.avalanche, TRACK_MUSIC.powder];
// MUSIC_LEVEL is a STARTING VALUE — a bed under the SFX, not a wall of sound.
// Tune by ear in ?solo=1: if it buries the cues, drop by 0.05; if it vanishes,
// raise it. It rides the master gain, so the volume slider scales it too.
// Settled at 0.28 by ear (Tim, 2026-06-14) when songs played raw; per-song
// gains now trim every pick to MUSIC_TARGET_LUFS (≈5 dB below the old average
// pick), so the level here is 0.28 × 10^(5.2/20) — same perceived bed height.
export const MUSIC_LEVEL = 0.51;
