'use strict';
// NativeCupSeries adapter conformance — DIFFERENTIAL against GrandPrix.js.
//
// Drives the JS CupSeries and the native one through the same race sequence and
// compares every observation after each step: standings (order, points, gained,
// lastRank), raceIndex/raceCount, current/next track, finished, and the cup object.
//
// The endless case is the interesting one. The shuffle bag is STATEFUL and lives
// in JS (page RNG, deliberately not sim state), so the adapter must pull from it
// exactly as often as the kit does — the kit draws inside applyRace and only while
// on the last race. Both sides here share ONE bag sequence via a scripted draw
// list, so an adapter that over-draws desynchronises and this test fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(ROOT, 'public/display/NativeCupSeries.js');
const MJS = path.join(ROOT, 'public/display/engine/native/ttp_runtime.mjs');

const skip = fs.existsSync(MJS)
  ? false
  : 'ttp_runtime.mjs not built — run native/scripts/build-runtime-web.sh';

// Sort OBJECT keys recursively but preserve ARRAY order: the ABI returns
// canonical (sorted-key) JSON while the kit returns insertion order, yet
// standings ORDER is contract — so positions must still compare strictly.
function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  return v;
}
const json = (v) => JSON.stringify(norm(v));

// A scripted draw source, so both implementations see the same sequence AND we
// can count how many draws each pulled.
function makeScriptedBag(ids) {
  let i = 0;
  return { draw: () => ids[i++ % ids.length], pulls: () => i };
}

const FIELD = [
  { peerIndex: 0, name: 'Ada', colorIndex: 0, ai: false },
  { peerIndex: 1, name: 'Bo', colorIndex: 1, ai: false },
  { peerIndex: 'cpu-bolt', name: 'Bolt', colorIndex: 2, ai: true },
  { peerIndex: 'cpu-zippy', name: 'Zippy', colorIndex: 3, ai: true }
];
// Deliberately varied: rank order rotates, one DNF, one absentee round.
const RACES = [
  [{ playerId: 0, rank: 1, finished: true }, { playerId: 1, rank: 2, finished: true },
   { playerId: 'cpu-bolt', rank: 3, finished: true }, { playerId: 'cpu-zippy', rank: 4, finished: true }],
  [{ playerId: 'cpu-bolt', rank: 1, finished: true }, { playerId: 0, rank: 2, finished: true },
   { playerId: 'cpu-zippy', rank: 3, finished: true }, { playerId: 1, rank: 4, finished: false }],
  [{ playerId: 1, rank: 1, finished: true }, { playerId: 'cpu-zippy', rank: 2, finished: true }],
  [{ playerId: 'cpu-zippy', rank: 1, finished: true }, { playerId: 0, rank: 2, finished: true },
   { playerId: 1, rank: 3, finished: true }, { playerId: 'cpu-bolt', rank: 4, finished: true }]
];

async function load() {
  const mod = await import(pathToFileURL(ADAPTER).href);
  await mod.init();
  return mod;
}

function compare(nv, js, label) {
  assert.equal(nv.raceCount, js.raceCount, `${label}: raceCount`);
  assert.equal(nv.raceIndex, js.raceIndex, `${label}: raceIndex`);
  assert.equal(nv.currentTrackId, js.currentTrackId, `${label}: currentTrackId`);
  assert.equal(nv.nextTrackId, js.nextTrackId, `${label}: nextTrackId`);
  assert.equal(nv.finished, js.finished, `${label}: finished`);
  assert.equal(nv.endless, js.endless ?? !!js.drawNext, `${label}: endless`);
  assert.equal(json(nv.cup.tracks), json(js.cup.tracks), `${label}: cup.tracks`);
  // Standings order is contract (points, then latest-race placement, then
  // first-seen), so compare the array positionally, not as a set.
  assert.equal(json(nv.standings()), json(js.standings()), `${label}: standings`);
}

test('NativeCupSeries matches GrandPrix.js through a fixed 4-race cup', { skip }, async () => {
  const mod = await load();
  const { CupSeries } = await import(pathToFileURL(path.join(ROOT, 'public/display/GrandPrix.js')).href);
  const CUP = { id: 'beach', name: 'Beach Cup', tracks: ['tidepool', 'helix', 'skysnake', 'gantry'] };

  const js = new CupSeries({ ...CUP, tracks: [...CUP.tracks] });
  const nv = new mod.NativeCupSeries({ ...CUP, tracks: [...CUP.tracks] });
  compare(nv, js, 'fresh');

  for (const [i, results] of RACES.entries()) {
    js.applyRace(results, FIELD);
    nv.applyRace(results, FIELD);
    compare(nv, js, `after applyRace ${i}`);
    js.advance();
    nv.advance();
    compare(nv, js, `after advance ${i}`);
  }
  assert.equal(nv.finished, true, 'a fixed cup finishes');
  nv.dispose();
});

test('NativeCupSeries matches GrandPrix.js in ENDLESS mode (shuffle-bag pulls included)',
  { skip }, async () => {
    const mod = await load();
    const { CupSeries } = await import(pathToFileURL(path.join(ROOT, 'public/display/GrandPrix.js')).href);
    const DRAWS = ['helix', 'skysnake', 'gantry', 'tidepool', 'helix', 'skysnake'];

    const jsBag = makeScriptedBag(DRAWS);
    const nvBag = makeScriptedBag(DRAWS);
    const js = new CupSeries({ id: 'random', name: 'Random', tracks: ['tidepool'] },
      { drawNext: () => jsBag.draw() });
    const nv = new mod.NativeCupSeries({ id: 'random', name: 'Random', tracks: ['tidepool'] },
      { drawNext: () => nvBag.draw() });
    compare(nv, js, 'fresh endless');

    for (const [i, results] of RACES.entries()) {
      js.applyRace(results, FIELD);
      nv.applyRace(results, FIELD);
      compare(nv, js, `endless applyRace ${i}`);
      // The bag is stateful: pulling more often than the kit would desynchronise
      // every later track, so the pull COUNT is part of the contract.
      assert.equal(nvBag.pulls(), jsBag.pulls(),
        `endless applyRace ${i}: shuffle-bag pulls (native ${nvBag.pulls()} vs kit ${jsBag.pulls()})`);
      js.advance();
      nv.advance();
      compare(nv, js, `endless advance ${i}`);
    }
    assert.equal(nv.finished, false, 'an endless series never finishes');
    assert.ok(nv.raceCount > 1, 'endless draws appended races');
    nv.dispose();
  });

test('NativeCupSeries rekey moves a seat mid-series like the kit', { skip }, async () => {
  const mod = await load();
  const { CupSeries } = await import(pathToFileURL(path.join(ROOT, 'public/display/GrandPrix.js')).href);
  const CUP = { id: 'beach', name: 'Beach Cup', tracks: ['tidepool', 'helix'] };
  const js = new CupSeries({ ...CUP, tracks: [...CUP.tracks] });
  const nv = new mod.NativeCupSeries({ ...CUP, tracks: [...CUP.tracks] });

  js.applyRace(RACES[0], FIELD);
  nv.applyRace(RACES[0], FIELD);
  js.rekey(0, 9);
  nv.rekey(0, 9);
  compare(nv, js, 'after rekey');
  // The rekeyed seat keeps its points under the new id.
  const row = nv.standings().find((r) => r.playerId === 9);
  assert.ok(row && row.points > 0, 'rekeyed seat kept its points');
  nv.dispose();
});
