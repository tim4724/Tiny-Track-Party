'use strict';
// Headless verification of the ribbon car engine with REAL steering: auto-
// accelerate, analog brake, steering→heading with u-turn clamp, curb slow (not
// stuck), lap counting, finishing. Cars no longer auto-follow corners, so tests
// that need a lap drive the racing line with a pure-pursuit helper (what a human
// does by sight).
const test = require('node:test');
const assert = require('node:assert/strict');

let buildTrack, OVAL, Game;
test.before(async () => {
  const tb = await import('../public/display/TrackBuilder.js');
  buildTrack = tb.buildTrack; OVAL = tb.OVAL;
  Game = (await import('../public/display/engine/Game.js')).Game;
});

function mkTrack(laps = 1) { const t = buildTrack(OVAL); t.totalLaps = laps; return t; }

// Pure-pursuit steer: aim at a point a few units ahead on the centerline.
function followSteer(game, track, id) {
  const c = game.cars.get(id);
  const snap = game.getSnapshot().cars.find((x) => x.id === id);
  const look = track.centerline.sampleAt(c.totalS + 3).pos;
  const d = look.clone().sub(snap.pose.pos).normalize();
  const err = Math.atan2(snap.pose.forward.clone().cross(d).dot(snap.pose.up), snap.pose.forward.dot(d));
  // negated to match the engine's STEER_SIGN (tilt direction) convention
  return Math.max(-1, Math.min(1, -err * 3));
}
function drive(game, track, id, seconds, brake = 0, dt = 16) {
  for (let i = 0; i < (seconds * 1000) / dt; i++) {
    game.processInput(id, { s: followSteer(game, track, id), b: brake });
    game.update(dt);
  }
}

test('cars auto-accelerate forward and progress', () => {
  const track = mkTrack(3);
  const game = new Game(['p1'], track, {});
  const before = game.getSnapshot().cars[0].pose.pos.clone();
  drive(game, track, 'p1', 2);
  const snap = game.getSnapshot().cars[0];
  assert.ok(snap.v > 5, `should be moving (v=${snap.v.toFixed(1)})`);
  assert.ok(snap.pose.pos.distanceTo(before) > 3, 'car should have moved along track');
});

test('braking slows the car', () => {
  const track = mkTrack(3);
  const game = new Game(['p1'], track, {});
  drive(game, track, 'p1', 3);
  const fast = game.getSnapshot().cars[0].v;
  drive(game, track, 'p1', 1.5, 1);
  const slow = game.getSnapshot().cars[0].v;
  assert.ok(slow < fast, `brake should reduce speed (${fast.toFixed(1)} -> ${slow.toFixed(1)})`);
});

test('analog brake settles at a proportional cruise speed', () => {
  const track = mkTrack(3);
  const game = new Game(['p1'], track, {});
  drive(game, track, 'p1', 4);
  const top = game.getSnapshot().cars[0].v;
  drive(game, track, 'p1', 3, 0.5);
  const half = game.getSnapshot().cars[0].v;
  assert.ok(half > 1, `50% brake should NOT fully stop (v=${half.toFixed(1)})`);
  assert.ok(half < top * 0.8, `50% brake should clearly slow it (${top.toFixed(1)} -> ${half.toFixed(1)})`);
  drive(game, track, 'p1', 3, 1);
  assert.ok(game.getSnapshot().cars[0].v < 0.5, 'full brake should stop the car');
});

test('hard steering reaches the curb but never gets stuck and cannot u-turn', () => {
  const track = mkTrack(3);
  const game = new Game(['p1'], track, {});
  for (let i = 0; i < 130; i++) { game.processInput('p1', { s: 1 }); game.update(16); }
  const car = game.getSnapshot().cars[0];
  assert.ok(Math.abs(car.lat) >= game.maxLat - 0.05, 'holding full steer should drive into a curb');
  assert.ok(car.v > 1, `rubbing the curb should slow but never stop (v=${car.v.toFixed(2)})`);
  // u-turn guard: heading magnitude stays within the clamp (can't point backward)
  assert.ok(Math.abs(game.cars.get('p1').heading) <= 1.26, 'heading must stay clamped (no u-turn)');
});

test('a full race finishes and emits events', () => {
  const events = [];
  const track = mkTrack(2);
  const game = new Game(['p1'], track, { onEvent: (e) => events.push(e) });
  for (let t = 0; t < 60 && !game.raceOver; t += 0.5) drive(game, track, 'p1', 0.5);
  const snap = game.getSnapshot().cars[0];
  assert.ok(snap.finished, 'car should finish the race');
  assert.ok(events.some((e) => e.type === 'lap'), 'should emit at least one lap event');
  assert.ok(events.some((e) => e.type === 'finish'), 'should emit finish');
  const res = game.getResults();
  assert.equal(res.results[0].playerId, 'p1');
});

test('ranking orders by progress', () => {
  const track = mkTrack(3);
  const game = new Game(['p1', 'p2'], track, {});
  // p1 drives the line; p2 brakes hard (stays put) → p1 should lead
  for (let i = 0; i < 200; i++) {
    game.processInput('p1', { s: followSteer(game, track, 'p1') });
    game.processInput('p2', { s: 0, b: 1 });
    game.update(16);
  }
  const p1 = game.getSnapshot().cars.find((c) => c.id === 'p1');
  assert.equal(p1.position, 1, 'moving car should be in the lead');
});
