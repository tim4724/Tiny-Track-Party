'use strict';
// Headless verification of the ribbon car engine with REAL steering: auto-
// accelerate, analog brake, steering→heading with u-turn clamp, curb slow (not
// stuck), lap counting, finishing. Cars no longer auto-follow corners, so tests
// that need a lap drive the racing line with a pure-pursuit helper (what a human
// does by sight).
const test = require('node:test');
const assert = require('node:assert/strict');

let buildTrack, OVAL, Game, AiController, RaceSession;
test.before(async () => {
  const tb = await import('../public/display/TrackBuilder.js');
  buildTrack = tb.buildTrack; OVAL = tb.OVAL;
  Game = (await import('../public/display/engine/Game.js')).Game;
  AiController = (await import('../public/display/AiDriver.js')).AiController;
  RaceSession = (await import('../public/display/RaceSession.js')).RaceSession;
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

test('a car whose player leaves mid-race forfeits and unblocks the finish', () => {
  const track = mkTrack(1);
  const game = new Game(['p1', 'p2'], track, {});
  // p2 holds full brake (stays put) — it would block raceOver forever.
  for (let i = 0; i < 60; i++) {
    game.processInput('p1', { s: followSteer(game, track, 'p1') });
    game.processInput('p2', { s: 0, b: 1 });
    game.update(16);
  }
  assert.equal(game.getSnapshot().cars.length, 2);
  // p2 leaves the room mid-race.
  assert.equal(game.removeCar('p2'), true);
  assert.equal(game.removeCar('p2'), false, 'removing the same car twice is a no-op');
  assert.equal(game.getSnapshot().cars.length, 1, 'forfeited car is gone from the snapshot');
  // Drive the lone remaining car home; the race must now be able to end.
  for (let t = 0; t < 60 && !game.raceOver; t += 0.5) drive(game, track, 'p1', 0.5);
  assert.ok(game.raceOver, 'race ends once the only remaining car finishes');
  const res = game.getResults();
  assert.equal(res.results.length, 1, 'results only include players still present');
  assert.equal(res.results[0].playerId, 'p1');
});

test('fastForwardToEnd runs the sim to the flag and reports true finish times', () => {
  // Stand-in for "only CPU cars remain": skip the countdown, then burst the whole
  // field to the line. Every car must finish with a real (positive, time-ordered)
  // result — that's the extrapolation the display does when the last human is in.
  const track = mkTrack(1);
  let ended = null;
  const session = new RaceSession(
    [{ peerIndex: 'p1' }, { peerIndex: 'p2' }], track,
    { onRaceEnd: (r) => { ended = r; } }
  );
  session.racing = true; // the burst doesn't touch the countdown timer
  const stepBots = () => {
    for (const id of ['p1', 'p2']) {
      const car = session.engine.cars.get(id);
      if (car && !car.finished) session.engine.processInput(id, { s: followSteer(session.engine, track, id) });
    }
  };
  session.fastForwardToEnd(stepBots);
  assert.ok(session.engine.raceOver, 'every car crossed the line');
  assert.ok(ended, 'onRaceEnd fired with the final board');
  assert.equal(ended.results.length, 2);
  assert.ok(ended.results.every((r) => r.finished && r.time > 0), 'all cars have real finish times');
  assert.ok(ended.results[0].time <= ended.results[1].time, 'results are ordered by finish time');
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

// ---- per-car stats ----------------------------------------------------------

// Peak speed a lone car reaches over a full-throttle run. We track the MAX seen
// (hit on the straights), not the instantaneous value — corner grip now scrubs
// speed mid-bend, so an end-of-run reading would be phase-dependent.
function topSpeed(stats, secs = 6) {
  const track = mkTrack(3);
  const game = new Game([{ id: 'x', stats }], track, {});
  let mx = 0;
  for (let i = 0; i < (secs * 1000) / 16; i++) {
    game.processInput('x', { s: followSteer(game, track, 'x'), b: 0 });
    game.update(16);
    mx = Math.max(mx, game.getSnapshot().cars[0].v);
  }
  return mx;
}

test('vmax stat scales top speed', () => {
  const base = topSpeed({});
  const fast = topSpeed({ vmax: 1.3 });
  const slow = topSpeed({ vmax: 0.7 });
  assert.ok(fast > base * 1.15, `vmax up → faster (${base.toFixed(1)} -> ${fast.toFixed(1)})`);
  assert.ok(slow < base * 0.85, `vmax down → slower (${base.toFixed(1)} -> ${slow.toFixed(1)})`);
});

test('accel stat scales how fast a car gets up to speed', () => {
  const speedAfter = (stats) => {
    const track = mkTrack(3);
    const game = new Game([{ id: 'x', stats }], track, {});
    drive(game, track, 'x', 0.5); // short burst, before either nears top speed
    return game.getSnapshot().cars[0].v;
  };
  const quick = speedAfter({ accel: 2.0 });
  const sluggish = speedAfter({ accel: 0.5 });
  assert.ok(quick > sluggish * 1.5, `more accel → quicker off the line (${sluggish.toFixed(1)} vs ${quick.toFixed(1)})`);
});

test('handling = cornering: a low-handling car washes wide at full speed; a grippy one holds the line', () => {
  // Drive the racing line at FULL throttle (never brake). A grippy car can yaw fast
  // enough to hold the line; a low-handling car can't (κ·v > turn·authority) so it
  // understeers wide into the curb. The sim does NOT auto-slow — that's the point.
  function corner(turnMult) {
    const track = mkTrack(3);
    const game = new Game([{ id: 'x', stats: { turn: turnMult } }], track, {});
    let maxAbsLat = 0, hitWall = false;
    for (let i = 0; i < 700; i++) {
      game.processInput('x', { s: followSteer(game, track, 'x'), b: 0 });
      game.update(16);
      const c = game.cars.get('x');
      if (i > 200) { maxAbsLat = Math.max(maxAbsLat, Math.abs(c.lat)); if (c.onWall) hitWall = true; }
    }
    return { maxAbsLat, hitWall };
  }
  const loose = corner(0.70);
  const grippy = corner(1.32);
  assert.ok(loose.maxAbsLat > grippy.maxAbsLat + 0.3, `low-handling car runs wider (loose ${loose.maxAbsLat.toFixed(2)} vs grippy ${grippy.maxAbsLat.toFixed(2)})`);
  assert.ok(loose.hitWall, 'a low-handling car at full speed washes into the curb');
  assert.ok(!grippy.hitWall, 'a grippy car holds the racing line at full speed');
});

test('cornerBrake lifts a low-handling bot for corners, cutting its curb time vs full throttle', () => {
  // Same low-handling car, driven flat-out vs by the AI controller (skill 1 → no
  // cruise handicap, so the only braking IS corner anticipation). The bot brakes
  // for bends it can't hold, so it spends far less time washed into the curb.
  function wallFrames(useBot) {
    const track = mkTrack(3);
    const game = new Game([{ id: 'x', stats: { turn: 0.70 } }], track, {});
    const bot = new AiController({ skill: 1.0 });
    let wall = 0, braked = false;
    for (let i = 0; i < 700; i++) {
      const c = game.cars.get('x');
      const cmd = useBot ? bot.drive(c, track.centerline) : { s: followSteer(game, track, 'x'), b: 0 };
      game.processInput('x', cmd);
      game.update(16);
      if (i > 200) { if (cmd.b > 0.05) braked = true; if (game.cars.get('x').onWall) wall++; }
    }
    return { wall, braked };
  }
  const bot = wallFrames(true), flat = wallFrames(false);
  assert.ok(bot.braked, 'the bot lifts/brakes for corners it cannot take flat-out');
  assert.ok(bot.wall < flat.wall * 0.6, `cornerBrake roughly halves curb time (${bot.wall} vs flat-out ${flat.wall})`);
});

test('straight-line speed is not handling-limited (only corners cost speed)', () => {
  // Neutral steer → no cornering → low- and high-handling cars reach the same top
  // speed (vmax is unchanged here, only turn differs).
  const v = (turnMult) => {
    const track = mkTrack(3);
    const game = new Game([{ id: 'x', stats: { turn: turnMult } }], track, {});
    let mx = 0;
    for (let i = 0; i < 250; i++) { game.processInput('x', { s: 0, b: 0 }); game.update(16); mx = Math.max(mx, game.cars.get('x').v); }
    return mx;
  };
  assert.ok(Math.abs(v(1.3) - v(0.7)) < 0.2, 'handling must not change straight-line top speed');
});

test('a stats-less (plain id) car keeps the benchmark feel', () => {
  // Same drive, one as a plain id and one with an all-1.0 stats object → identical.
  const t1 = mkTrack(3), g1 = new Game(['x'], t1, {});
  const t2 = mkTrack(3), g2 = new Game([{ id: 'x', stats: { accel: 1, vmax: 1, turn: 1, mass: 1 } }], t2, {});
  drive(g1, t1, 'x', 3); drive(g2, t2, 'x', 3);
  const v1 = g1.getSnapshot().cars[0].v, v2 = g2.getSnapshot().cars[0].v;
  assert.ok(Math.abs(v1 - v2) < 1e-6, `default == explicit-1.0 (${v1} vs ${v2})`);
});

// ---- car-car collisions -----------------------------------------------------

// Park two cars at fixed (s, lat) and step once with both braked so the
// integration barely moves them and we observe pure collision resolution.
function parkPair(aPos, bPos, statsA, statsB) {
  const track = mkTrack(3);
  const game = new Game([{ id: 'a', stats: statsA }, { id: 'b', stats: statsB }], track, {});
  const a = game.cars.get('a'), b = game.cars.get('b');
  Object.assign(a, aPos); Object.assign(b, bPos);
  return { game, track };
}

test('overlapping cars are pushed apart (no penetration)', () => {
  const { game } = parkPair({ totalS: 5.0, lat: 0, v: 0 }, { totalS: 5.5, lat: 0, v: 0 });
  game.processInput('a', { b: 1 }); game.processInput('b', { b: 1 });
  const before = Math.abs(game.cars.get('b').totalS - game.cars.get('a').totalS);
  game.update(16);
  const after = Math.abs(game.cars.get('b').totalS - game.cars.get('a').totalS);
  assert.ok(after > before, `cars should separate (${before.toFixed(2)} -> ${after.toFixed(2)})`);
  assert.ok(after > 0.75, `gap should clear the summed footprints (${after.toFixed(2)})`);
});

test('a rear-end bump slows the chaser and nudges the car ahead', () => {
  const { game } = parkPair({ totalS: 5.0, lat: 0, v: 8 }, { totalS: 5.5, lat: 0, v: 2 });
  game.processInput('a', { s: 0, b: 0 }); // chaser keeps its foot down
  game.processInput('b', { s: 0, b: 1 }); // car ahead is crawling
  game.update(16);
  const a = game.cars.get('a'), b = game.cars.get('b');
  assert.ok(a.v < 8, `chaser should shed speed on impact (v=${a.v.toFixed(1)})`);
  assert.ok(b.v > 2.2, `car ahead should get shoved forward (v=${b.v.toFixed(1)})`);
});

test('weight decides a side bump: the heavy car barely budges, the light one is shoved', () => {
  const heavy = { mass: 3 }, light = { mass: 1 };
  const { game } = parkPair({ totalS: 5, lat: 0, v: 0 }, { totalS: 5, lat: 0.2, v: 0 }, heavy, light);
  const hLat0 = game.cars.get('a').lat, lLat0 = game.cars.get('b').lat;
  game.processInput('a', { b: 1 }); game.processInput('b', { b: 1 });
  game.update(16);
  const dH = Math.abs(game.cars.get('a').lat - hLat0);
  const dL = Math.abs(game.cars.get('b').lat - lLat0);
  assert.ok(dL > dH * 1.8, `light car moves much more than heavy (heavy ${dH.toFixed(3)} vs light ${dL.toFixed(3)})`);
});

test('finished cars are ghosts — a live car is not shoved by one', () => {
  // b sits braked, overlapping a finished car on both axes. If the finished car
  // were solid the overlap would knock b sideways and/or shove it along the
  // track; as a ghost it passes straight through, so b stays exactly put.
  const { game } = parkPair({ totalS: 5.0, lat: 0, v: 0 }, { totalS: 5.0, lat: 0.05, v: 0 });
  game.cars.get('a').finished = true; // a finished and is now on its victory lap
  const b = game.cars.get('b');
  const bS0 = b.totalS, bLat0 = b.lat;
  game.processInput('b', { s: 0, b: 1 }); // b parked; only a collision could move it
  game.update(16);
  assert.ok(Math.abs(b.totalS - bS0) < 1e-9, 'live car is not shoved along the track by a finished (ghost) car');
  assert.ok(Math.abs(b.lat - bLat0) < 1e-9, 'live car is not knocked sideways by a finished (ghost) car');
});

test('a finished car keeps driving on autopilot instead of stopping', () => {
  const track = mkTrack(1);
  const game = new Game(['p1'], track, {});
  for (let t = 0; t < 60 && !game.raceOver; t += 0.5) drive(game, track, 'p1', 0.5);
  assert.ok(game.cars.get('p1').finished, 'p1 should have finished the race');
  const s0 = game.cars.get('p1').totalS;
  // keep ticking with NO player input — the engine should autopilot the winner
  // around the track (a victory lap), not let it coast to a halt.
  for (let i = 0; i < 180; i++) game.update(16); // ~3 s
  const c = game.cars.get('p1');
  assert.ok(c.v > 3, `finished car should keep cruising, not stop (v=${c.v.toFixed(2)})`);
  assert.ok(c.totalS > s0 + 5, `finished car should keep covering ground (Δs=${(c.totalS - s0).toFixed(2)})`);
  assert.ok(Math.abs(c.lat) <= game.maxLat + 1e-6, 'autopilot keeps it within the curbs');
});
