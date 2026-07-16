'use strict';
// Drift guard for the (future) credits screen's data: every shipped song must
// carry complete attribution fields, and creditsFor() must surface them all as
// required — CC-BY 4.0 makes missing music attribution a licence violation,
// not a cosmetic bug.
const test = require('node:test');
const assert = require('node:assert/strict');

let RACE_MUSIC, MUSIC_FALLBACK, ASSET_CREDITS, MUSIC_ATTRIBUTION_LINE, creditsFor;
test.before(async () => {
  ({ RACE_MUSIC, MUSIC_FALLBACK } = await import('../public/display/Audio.js'));
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

test('creditsFor() lists every unique song exactly once, as required credits', () => {
  const sections = creditsFor(RACE_MUSIC);
  const music = sections.find((s) => s.section === 'Music');
  assert.ok(music, 'a Music section exists');

  const uniqueTitles = new Set(Object.values(RACE_MUSIC).flat().map((s) => s.title));
  assert.equal(music.entries.length, uniqueTitles.size, 'one credit per unique song');
  for (const e of music.entries) {
    assert.equal(e.required, true, `music credit '${e.title}' must be flagged required (CC-BY)`);
    assert.ok(e.author && e.license && e.url, `music credit '${e.title}' is complete`);
  }
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
