'use strict';
// Grand Prix series engine (public/display/GrandPrix.js): points banking,
// cup-standings tie-breaks, race advancement, roster churn (late joiner /
// dropped player / reconnect rekey) and the no-repeat shuffle bag. Pure module —
// results/field rows are hand-built here in the exact shapes the display feeds
// it (Game.getResults().results and currentField).
const test = require('node:test');
const assert = require('node:assert/strict');

let CupSeries, makeShuffleBag, POINTS_BY_RANK;
test.before(async () => {
  ({ CupSeries, makeShuffleBag, POINTS_BY_RANK } = await import('../public/display/GrandPrix.js'));
});

const CUP = { id: 'beach', name: 'Beach Cup', tracks: ['tidepool', 'cove', 'driftwood', 'riptide'] };

// A finished result row and the matching field seat. Humans get numeric ids,
// bots 'ai-N' strings — the class must not care.
const res = (playerId, rank, finished = true, time = rank * 10) => ({ playerId, rank, finished, time });
const seat = (peerIndex, ai = false) => ({ peerIndex, name: `P${peerIndex}`, colorIndex: 0, ai });

const FIELD4 = [seat(1), seat(2), seat('ai-1', true), seat('ai-2', true)];
const order = (s) => s.standings().map((r) => r.playerId);
const byId = (s, id) => s.standings().find((r) => r.playerId === id);

test('points follow POINTS_BY_RANK; DNF earns zero regardless of rank', () => {
  const s = new CupSeries(CUP);
  s.applyRace([res(1, 1), res(2, 2), res('ai-1', 3, false), res('ai-2', 4)], FIELD4);
  assert.equal(byId(s, 1).points, POINTS_BY_RANK[0]);
  assert.equal(byId(s, 2).points, POINTS_BY_RANK[1]);
  assert.equal(byId(s, 'ai-1').points, 0);          // DNF in 3rd → nothing
  assert.equal(byId(s, 'ai-2').points, POINTS_BY_RANK[3]);
  assert.equal(byId(s, 1).gained, 9);
  assert.equal(byId(s, 'ai-1').lastRank, 3);        // rank still recorded for tie-breaks
});

test('points accumulate across races and gained resets to the latest race', () => {
  const s = new CupSeries(CUP);
  s.applyRace([res(1, 1), res(2, 2)], FIELD4);      // P1 +9, P2 +6
  s.advance();
  s.applyRace([res(1, 2), res(2, 1)], FIELD4);      // P1 +6, P2 +9
  assert.equal(byId(s, 1).points, 15);
  assert.equal(byId(s, 2).points, 15);
  assert.equal(byId(s, 1).gained, 6);               // this race only, not the total
});

test('tie on points breaks by placement in the latest race', () => {
  const s = new CupSeries(CUP);
  s.applyRace([res(1, 1), res(2, 2), res('ai-1', 3), res('ai-2', 4)], FIELD4);
  s.advance();
  s.applyRace([res(1, 2), res(2, 1), res('ai-1', 3), res('ai-2', 4)], FIELD4);
  // P1 and P2 both hold 15; P2 won the latest race so P2 leads the cup.
  assert.deepEqual(order(s), [2, 1, 'ai-1', 'ai-2']);
});

test('sitting out the latest race loses an equal-points tie', () => {
  const s = new CupSeries(CUP);
  s.applyRace([res(1, 1), res(2, 3)], FIELD4);      // P1 9, P2 3
  s.advance();
  s.applyRace([res(2, 2)], [seat(2)]);              // P1 absent; P2 +6 → 9
  const ids = order(s);
  assert.ok(ids.indexOf(2) < ids.indexOf(1), 'the player who raced ranks above the absentee');
});

test('double ties keep first-seen order (stable across broadcasts)', () => {
  const s = new CupSeries(CUP);
  s.applyRace([res(1, 3), res(2, 3, false), res('ai-1', 1)], FIELD4); // P1 3, P2 0(DNF), ai-1 9
  s.advance();
  s.applyRace([res('ai-1', 1)], [seat('ai-1', true)]);                // P1 & P2 both sit out
  // P1 (3 pts) above P2 (0); repeated standings() calls never reorder them.
  assert.deepEqual(order(s), ['ai-1', 1, 2]);
  assert.deepEqual(order(s), ['ai-1', 1, 2]);
});

test('late joiner scores from their first race; dropped player keeps points, gains +0', () => {
  const s = new CupSeries(CUP);
  s.applyRace([res(1, 1), res(2, 2)], FIELD4);            // race 1: no P5 yet
  s.advance();
  s.applyRace([res(1, 2), res(5, 1)], [seat(1), seat(5)]); // race 2: P5 joined, P2 dropped
  assert.equal(byId(s, 5).points, 9);                     // nothing carried from race 1
  assert.equal(byId(s, 2).points, 6);                     // banked points survive the drop
  assert.equal(byId(s, 2).gained, 0);                     // ...but this round reads "+0"
});

test('rekey carries a reconnected player\'s cup over to the new id', () => {
  const s = new CupSeries(CUP);
  s.applyRace([res(1, 1), res(2, 2)], FIELD4);
  s.rekey(1, 7);
  assert.equal(byId(s, 7).points, 9);
  assert.equal(byId(s, 1), undefined);
  s.rekey(99, 100); // unknown id → no-op, no throw
});

test('advancement walks the cup: track ids, finished flag, end clamp', () => {
  const s = new CupSeries(CUP);
  assert.equal(s.raceCount, 4);
  assert.equal(s.currentTrackId, 'tidepool');
  assert.equal(s.nextTrackId, 'cove');
  assert.equal(s.finished, false);
  for (let i = 0; i < 3; i++) {
    s.applyRace([res(1, 1)], [seat(1)]);
    assert.equal(s.finished, false, `race ${i + 1} of 4 must not finish the cup`);
    s.advance();
  }
  assert.equal(s.currentTrackId, 'riptide');
  assert.equal(s.nextTrackId, null);                // nothing after the last race
  s.applyRace([res(1, 1)], [seat(1)]);
  assert.equal(s.finished, true);                   // final results in → podium
  s.advance();                                      // clamps, doesn't run off the cup
  assert.equal(s.currentTrackId, 'riptide');
  assert.equal(byId(s, 1).points, 4 * POINTS_BY_RANK[0]);
});

test('endless series (drawNext) always has a next race and never finishes', () => {
  const draws = ['t1', 't2', 't3'];
  let i = 0;
  const s = new CupSeries({ id: 'random', name: 'Random', tracks: ['seed'] }, { drawNext: () => draws[i++ % draws.length] });
  assert.equal(s.endless, true);
  assert.equal(s.currentTrackId, 'seed');
  assert.equal(s.nextTrackId, null);              // nothing drawn until results are in
  for (let n = 0; n < 6; n++) {
    s.applyRace([res(1, 1)], [seat(1)]);
    assert.equal(s.finished, false, 'endless play never reaches a podium');
    assert.ok(s.nextTrackId, 'every intermission has the next draw on deck');
    s.advance();
  }
  assert.equal(s.raceIndex, 6);
  assert.equal(byId(s, 1).points, 6 * POINTS_BY_RANK[0]); // the tally keeps running
});

test('a series never mutates the cup entry it was built from', () => {
  const cup = { id: 'random', name: 'Random', tracks: ['seed'] };
  const s = new CupSeries(cup, { drawNext: () => 'drawn' });
  s.applyRace([res(1, 1)], [seat(1)]);            // appends the draw to the SERIES list
  assert.deepEqual(cup.tracks, ['seed'], 'caller-owned track list untouched');
  assert.equal(s.nextTrackId, 'drawn');
});

// Deterministic LCG so bag behaviour is reproducible (the display injects
// Math.random; the purity gate keeps it OUT of GrandPrix.js itself).
const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;

test('shuffle bag deals every id before repeating, without a boundary repeat', () => {
  const ids = Array.from({ length: 16 }, (_, i) => `t${i}`);
  const bag = makeShuffleBag(ids, lcg(42));
  const first = Array.from({ length: 16 }, () => bag.draw());
  assert.equal(new Set(first).size, 16, 'first pass covers all ids');
  const second = Array.from({ length: 16 }, () => bag.draw());
  assert.equal(new Set(second).size, 16, 'second pass covers all ids');
  assert.notEqual(second[0], first[15], 'no immediate repeat across the reshuffle');
});

test('shuffle bag is deterministic for a fixed rng and shuffles for real', () => {
  const ids = Array.from({ length: 16 }, (_, i) => `t${i}`);
  const seq = (seed, n) => { const b = makeShuffleBag(ids, lcg(seed)); return Array.from({ length: n }, () => b.draw()); };
  assert.deepEqual(seq(7, 32), seq(7, 32));                     // same seed → same draws
  assert.notDeepEqual(seq(7, 16), ids, 'a shuffled pass is not the input order');
});
