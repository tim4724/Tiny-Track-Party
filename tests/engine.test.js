'use strict';
// Headless verification of the ribbon-follow car engine: auto-accelerate,
// braking, steering→lateral with wall clamp, lap counting, and finishing.
const test = require('node:test');
const assert = require('node:assert/strict');

let buildTrack, OVAL, Game;
test.before(async () => {
  const tb = await import('../public/display/TrackBuilder.js');
  buildTrack = tb.buildTrack; OVAL = tb.OVAL;
  Game = (await import('../public/display/engine/Game.js')).Game;
});

function mkTrack(laps = 1) {
  const t = buildTrack(OVAL);
  t.totalLaps = laps;
  return t;
}
function step(game, seconds, dt = 16) {
  for (let i = 0; i < (seconds * 1000) / dt; i++) game.update(dt);
}

test('cars auto-accelerate forward and progress', () => {
  const game = new Game(['p1'], mkTrack(3), {});
  const before = game.getSnapshot().cars[0].pose.pos.clone();
  step(game, 2);
  const snap = game.getSnapshot().cars[0];
  assert.ok(snap.v > 5, `should be moving (v=${snap.v.toFixed(1)})`);
  assert.ok(snap.pose.pos.distanceTo(before) > 3, 'car should have moved along track');
});

test('braking slows the car', () => {
  const game = new Game(['p1'], mkTrack(3), {});
  step(game, 3);
  const fast = game.getSnapshot().cars[0].v;
  game.processInput('p1', { b: true });
  step(game, 1.5);
  const slow = game.getSnapshot().cars[0].v;
  assert.ok(slow < fast, `brake should reduce speed (${fast.toFixed(1)} -> ${slow.toFixed(1)})`);
});

test('analog brake settles at a proportional cruise speed', () => {
  const game = new Game(['p1'], mkTrack(3), {});
  step(game, 4); // reach ~top speed
  const top = game.getSnapshot().cars[0].v;
  game.processInput('p1', { b: 0.5 }); // half brake
  step(game, 3);
  const half = game.getSnapshot().cars[0].v;
  assert.ok(half > 1, `50% brake should NOT fully stop (v=${half.toFixed(1)})`);
  assert.ok(half < top * 0.75, `50% brake should clearly slow it (${top.toFixed(1)} -> ${half.toFixed(1)})`);
  // full brake → stop
  game.processInput('p1', { b: 1 });
  step(game, 3);
  assert.ok(game.getSnapshot().cars[0].v < 0.5, 'full brake should stop the car');
});

test('steering moves lateral and clamps at the wall', () => {
  const game = new Game(['p1'], mkTrack(3), {});
  step(game, 2);
  game.processInput('p1', { s: 1 });
  step(game, 3);
  const lat = game.getSnapshot().cars[0].lat;
  assert.ok(lat > 0, 'steering right should increase lat');
  assert.ok(lat <= game.maxLat + 1e-6, 'lat must not exceed the wall');
});

test('a full race finishes and emits events', () => {
  const events = [];
  const game = new Game(['p1'], mkTrack(2), { onEvent: (e) => events.push(e) });
  // drive straight; let it run plenty long to finish 2 laps
  step(game, 30);
  const snap = game.getSnapshot().cars[0];
  assert.ok(snap.finished, 'car should finish the race');
  assert.ok(events.some((e) => e.type === 'lap'), 'should emit at least one lap event');
  assert.ok(events.some((e) => e.type === 'finish'), 'should emit finish');
  assert.ok(game.raceOver, 'race should be over with one finisher');
  const res = game.getResults();
  assert.equal(res.results[0].playerId, 'p1');
  assert.equal(res.results[0].rank, 1);
});

test('ranking orders by progress', () => {
  const game = new Game(['p1', 'p2'], mkTrack(3), {});
  // p1 drives, p2 brakes (stays put) → p1 should rank ahead
  step(game, 1);
  for (let i = 0; i < 200; i++) { game.processInput('p2', { b: true }); game.update(16); }
  const cars = game.getSnapshot().cars;
  const p1 = cars.find((c) => c.id === 'p1');
  assert.equal(p1.position, 1, 'moving car should be in the lead');
});
