'use strict';
// The scene budget's baseline must cover every track (and only those), at
// every player count the gate reads, and carry a ceiling.
//
// WHY. `npm run budget:scene` needs a browser and a lap per track, so it does
// not run here — and a gate that is only run by hand is a gate that drifts. A
// track added without a recorded figure is a track nobody has priced; this is
// the coverage half that keeps the slow check honest (scripts/CLAUDE.md: every
// baked family has a coverage gate). The figures themselves are re-recorded
// on purpose with `--record`, like the corpora.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/scene-budget.json'), 'utf8'));

test('scene budget: the baseline prices every track at 1 and 4 players', async () => {
  const { TRACKS } = await import(path.join(ROOT, 'public/shared/tracks.js'));
  const { DEV_TRACKS } = await import(path.join(ROOT, 'public/shared/devTracks.js'));
  const ids = [...Object.keys(TRACKS), ...Object.keys(DEV_TRACKS)];
  const missing = [];
  for (const id of ids) {
    for (const p of ['1', '4']) {
      if (!(baseline.tracks[id]?.[p]?.worst > 0)) missing.push(`${id} ${p}P`);
    }
  }
  assert.deepStrictEqual(missing, [], 'unpriced — run `npm run budget:scene -- --track <id> --record`');
  assert.deepStrictEqual(Object.keys(baseline.tracks).filter((id) => !ids.includes(id)), [],
    'priced tracks that no longer exist — delete their entries');
});

test('scene budget: the 4P ceiling is set', () => {
  assert.ok(baseline.ceiling > 0, 'tests/fixtures/scene-budget.json needs a ceiling');
});
