'use strict';
// The scene budget's baseline must price every track (and only those) in both
// detail tiers, at every player count the gate reads, and carry each tier's
// two 4P ceilings.
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
// ttp/detail.h's tiers: full (the web, the Apple TV) and lite (the Android TV).
const TIERS = ['full', 'lite'];

test('scene budget: the baseline is one entry per detail tier', () => {
  assert.deepStrictEqual(Object.keys(baseline).sort(), [...TIERS].sort());
});

test('scene budget: each tier prices every track at 1 and 4 players', async () => {
  const { TRACKS } = await import(path.join(ROOT, 'public/shared/tracks.js'));
  const { DEV_TRACKS } = await import(path.join(ROOT, 'public/shared/devTracks.js'));
  const ids = [...Object.keys(TRACKS), ...Object.keys(DEV_TRACKS)];
  for (const tier of TIERS) {
    const tracks = baseline[tier].tracks;
    const missing = [];
    for (const id of ids) {
      for (const p of ['1', '4']) {
        if (!(tracks[id]?.[p]?.worst > 0)) missing.push(`${id} ${p}P`);
      }
    }
    assert.deepStrictEqual(missing, [],
      `${tier} unpriced — run \`npm run budget:scene -- --detail ${tier} --track <id> --record\``);
    assert.deepStrictEqual(Object.keys(tracks).filter((id) => !ids.includes(id)), [],
      `${tier} prices tracks that no longer exist — delete their entries`);
  }
});

test('scene budget: each tier sets its 4P ceilings, and lite\'s are the tighter', () => {
  for (const tier of TIERS) {
    assert.ok(baseline[tier].ceiling > 0, `tests/fixtures/scene-budget.json: ${tier} needs a ceiling`);
    assert.ok(baseline[tier].drawCeiling > 0, `tests/fixtures/scene-budget.json: ${tier} needs a drawCeiling`);
  }
  // Lite exists for the weakest device; a full ceiling under it would make
  // the tier that ships on the stronger ones the one held tighter.
  assert.ok(baseline.full.ceiling >= baseline.lite.ceiling, 'full ceiling under lite\'s');
  assert.ok(baseline.full.drawCeiling >= baseline.lite.drawCeiling, 'full drawCeiling under lite\'s');
});
