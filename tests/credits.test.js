'use strict';
// Drift guard for the (future) credits screen's data: every shipped song must
// carry complete attribution fields, and creditsFor() must surface them all as
// required — CC-BY 4.0 makes missing music attribution a licence violation,
// not a cosmetic bug.
const test = require('node:test');
const assert = require('node:assert/strict');

let RACE_MUSIC, MUSIC_FALLBACK, MUSIC_TARGET_LUFS, ASSET_CREDITS, MUSIC_ATTRIBUTION_LINE, creditsFor;
test.before(async () => {
  ({ RACE_MUSIC, MUSIC_FALLBACK, MUSIC_TARGET_LUFS } = await import('../public/display/audio/decide.js'));
  ({ ASSET_CREDITS, MUSIC_ATTRIBUTION_LINE, creditsFor } = await import('../public/shared/credits.js'));
});

test('every RACE_MUSIC song carries full attribution fields', () => {
  for (const [biome, pool] of Object.entries(RACE_MUSIC)) {
    assert.ok(pool.length > 0, `biome '${biome}' has an empty pool — delete the key instead`);
    for (const s of pool) {
      for (const field of ['file', 'title', 'artist', 'license', 'source']) {
        assert.ok(s[field], `${biome}: '${s.title || s.file}' is missing '${field}'`);
      }
    }
  }
  assert.ok(MUSIC_FALLBACK.length > 0, 'MUSIC_FALLBACK must never be empty (it is the no-silence guarantee)');
});

test('every song carries a loudness measurement and an attenuating gain', () => {
  for (const [biome, pool] of Object.entries(RACE_MUSIC)) {
    for (const s of pool) {
      assert.ok(Number.isFinite(s.lufs) && s.lufs < 0,
        `${biome}: '${s.title}' needs a measured integrated LUFS (see the ffmpeg recipe in Audio.js)`);
      assert.ok(s.gain > 0 && s.gain <= 1,
        `${biome}: '${s.title}' gain ${s.gain} outside (0, 1] — a pick quieter than ` +
        'MUSIC_TARGET_LUFS means the target (and MUSIC_LEVEL) need rebalancing');
    }
  }
});

// decide.js bakes each `gain` as a LITERAL instead of evaluating
// `10 ** ((MUSIC_TARGET_LUFS - lufs) / 20)` at load, because `**` is V8's pow —
// implementation-approximated, disagreeing with the fdlibm the C++ port links on 2
// of the 23 shipped trims — and this number is recorded into audio-corpus.jsonl,
// which a port has to match bit-for-bit (docs/native-port/fp-profile.md §2).
// Literals are portable; the derivation is not. This re-runs it anyway so the
// literals stay honest: a typo or a new song carrying a stale trim fails here,
// while the recorded byte path keeps resting on a decimal both languages parse
// identically. The tolerance absorbs exactly the last-bit spread between two
// conforming pow implementations and nothing more — 1e-12 relative is ~4500 ULP,
// far under the 1e-3 a genuinely wrong trim would be off by.
test('each song gain is the LUFS trim it claims to be, without the byte path using pow', () => {
  for (const [biome, pool] of Object.entries(RACE_MUSIC)) {
    for (const s of pool) {
      const derived = 10 ** ((MUSIC_TARGET_LUFS - s.lufs) / 20);
      assert.ok(Math.abs(s.gain - derived) <= 1e-12 * derived,
        `${biome}: '${s.title}' gain ${s.gain} does not match its ${s.lufs} LUFS trim ` +
        `(expected ~${derived}). Re-derive with: node -e "console.log(10 ** ((${MUSIC_TARGET_LUFS} - ${s.lufs}) / 20))"`);
    }
  }
});

test('creditsFor() lists every unique song exactly once, as required credits', () => {
  const sections = creditsFor(RACE_MUSIC);
  const music = sections.find((s) => s.section === 'Music');
  assert.ok(music, 'a Music section exists');

  const uniqueTitles = new Set(Object.values(RACE_MUSIC).flat().map((s) => s.title));
  assert.equal(music.entries.length, uniqueTitles.size, 'one credit per unique song');
  for (const e of music.entries) {
    assert.equal(e.required, /CC-BY/i.test(e.license),
      `music credit '${e.title}' required-flag must follow its license (CC-BY = required)`);
    assert.ok(e.author && e.license && e.url, `music credit '${e.title}' is complete`);
  }
  assert.ok(music.entries.some((e) => e.required), 'the CC-BY songs keep their required credits');
});

test('static asset credits are complete and the CC-BY line names the licence', () => {
  for (const e of ASSET_CREDITS) {
    for (const field of ['section', 'title', 'author', 'license', 'url']) {
      assert.ok(e[field], `'${e.title || '?'}' is missing '${field}'`);
    }
  }
  assert.match(MUSIC_ATTRIBUTION_LINE, /Attribution 4\.0/);
  assert.match(MUSIC_ATTRIBUTION_LINE, /creativecommons\.org\/licenses\/by\/4\.0/);
});
