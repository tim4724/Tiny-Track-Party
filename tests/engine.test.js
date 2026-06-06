'use strict';
// Headless verification of the ribbon car engine with REAL steering: auto-
// accelerate, analog brake, steering→heading with u-turn clamp, curb slow (not
// stuck), lap counting, finishing. Cars no longer auto-follow corners, so tests
// that need a lap drive the racing line with a pure-pursuit helper (what a human
// does by sight).
const test = require('node:test');
const assert = require('node:assert/strict');

let buildTrack, Game, AiController, RaceSession;
test.before(async () => {
  const tb = await import('../public/display/TrackBuilder.js');
  buildTrack = tb.buildTrack;
  Game = (await import('../public/display/engine/Game.js')).Game;
  AiController = (await import('../public/display/AiDriver.js')).AiController;
  RaceSession = (await import('../public/display/RaceSession.js')).RaceSession;
});

// A compact closed oval (sides 4/2/4/2, large sweeping corners) used as the
// fixture for every engine test. Deliberately a PRIVATE shape, not a catalogue
// track: these tests probe PHYSICS (accel, curb wash, corner braking, lap counting)
// and must stay valid as the catalogue tracks are re-tuned for length/variety — a
// long front straight there would push the first corner past a test's sim window,
// or a 2-lap race past its time budget. Catalogue closure is covered separately
// in tests/track.test.js. Large corners (same R as the catalogue) keep the
// understeer/corner-brake behaviour identical; only the straights are short.
// Parametric segment DSL (local, since this CommonJS test can't import the ES-module
// helpers at module-eval time). angle>0 = LEFT turn.
const L = 4.0, RL = 4.185;
const straight = (length, opts = {}) => ({ kind: 'straight', length, ...opts });
const arc = (radius, angle, opts = {}) => ({ kind: 'arc', radius, angle, ...opts });
const run = (n) => Array.from({ length: n }, () => straight(L));
const TEST_OVAL = [
  ...run(4), arc(RL, 90), ...run(2), arc(RL, 90),
  ...run(4), arc(RL, 90), ...run(2), arc(RL, 90)
];

function mkTrack(laps = 1) { const t = buildTrack(TEST_OVAL); t.totalLaps = laps; return t; }

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

// ---- oil slicks (spin-out hazard) ------------------------------------------

test('an oil slick spins a car out: steering dies + speed scrubs, then control returns', () => {
  // Slick on the opening straight (small s, before the first corner). A car that
  // drives onto it should ignore full steer and shed speed, then recover.
  const track = mkTrack(3);
  track.hazards = [{ s: 5, lat: 0, radius: 1.1 }];
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 5, lat: 0, v: 8, heading: 0 });

  // one tick lands the car's centre on the slick
  game.processInput('p1', { s: 1, b: 0 }); game.update(16);
  assert.ok(car.spinT > 0, 'driving onto oil triggers a spin-out');
  // speed bleeds GENTLY (loss of grip), not an abrupt scrub
  assert.ok(car.v < 8 && car.v > 7.5, `gentle deceleration on entry, no hard stop (v=${car.v.toFixed(2)})`);
  // the cosmetic whirl advances on the following ticks
  game.processInput('p1', { s: 1, b: 0 }); game.update(16);
  assert.ok(game.getSnapshot().cars[0].spin > 0, 'snapshot exposes a cosmetic spin angle');

  // hold full steer mid-spin: a controllable car would swing wide on the straight,
  // but steering is dead so the slick car stays near the centreline — and it keeps
  // rolling forward (drives THROUGH the slick, spinning out behind it).
  const lat0 = car.lat, s0 = car.totalS;
  for (let i = 0; i < 25; i++) { game.processInput('p1', { s: 1, b: 0 }); game.update(16); }
  assert.ok(car.spinT > 0, 'still spinning ~0.4s in');
  assert.ok(Math.abs(car.lat - lat0) < 0.3, `steering is dead while spinning (Δlat=${(car.lat - lat0).toFixed(2)})`);
  assert.ok(car.totalS - s0 > 1.5, `car keeps moving through the slick (Δs=${(car.totalS - s0).toFixed(2)})`);

  // run the spin out; control returns and full steer now moves the car laterally
  for (let i = 0; i < 60; i++) { game.processInput('p1', { s: 1, b: 0 }); game.update(16); }
  assert.equal(car.spinT, 0, 'spin-out recovers after ~1s');
  const lat1 = car.lat;
  for (let i = 0; i < 25; i++) { game.processInput('p1', { s: 1, b: 0 }); game.update(16); }
  assert.ok(Math.abs(car.lat - lat1) > 0.3, `steering works again once recovered (Δlat=${(car.lat - lat1).toFixed(2)})`);
});

test('a car parked on a slick spins out once, not every frame (rising-edge)', () => {
  const track = mkTrack(3);
  track.hazards = [{ s: 5, lat: 0, radius: 1.1 }];
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 5, lat: 0, v: 0, heading: 0 });

  // full brake → the car sits on the slick the whole test
  game.processInput('p1', { b: 1 }); game.update(16);
  assert.ok(car.spinT > 0, 'first contact spins it out');
  for (let i = 0; i < 120; i++) { game.processInput('p1', { b: 1 }); game.update(16); }
  assert.equal(car.spinT, 0, 'the single spin has ended');
  assert.ok(car.oilIn.has(0), 'car is still sitting on the slick');
  // must NOT re-trigger while parked: it has to leave and re-enter to spin again
  for (let i = 0; i < 30; i++) {
    game.processInput('p1', { b: 1 }); game.update(16);
    assert.equal(car.spinT, 0, 'no re-trigger while parked on the slick');
  }
});

test('a second oil slick entered mid-spin re-arms the spin (not silently absorbed)', () => {
  const track = mkTrack(3);
  track.hazards = [{ s: 6, lat: 0, radius: 1.0 }, { s: 30, lat: 0, radius: 1.0 }];
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 6, lat: 0, v: 8, heading: 0 });
  game.update(16);                                  // enter slick-1 → spin starts
  assert.ok(car.spinT > 0, 'slick-1 starts the spin');
  for (let i = 0; i < 20; i++) game.update(16);     // let the spin tick partway down
  const mid = car.spinT;
  assert.ok(mid > 0 && mid < 0.9, `still spinning, timer partly elapsed (spinT=${mid.toFixed(2)})`);
  // drop the still-spinning car onto slick-2: a fresh hazard must RE-ARM the spin
  // rather than being swallowed (the old `!spinning` guard dropped the second spin).
  Object.assign(car, { totalS: 30, lat: 0 });
  game.update(16);
  assert.ok(car.spinT > mid + 0.2, `second slick re-arms the spin (spinT ${car.spinT.toFixed(2)} > ${mid.toFixed(2)})`);
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

// ---- boost pads + catch-up factor -------------------------------------------

test('a boost pad lifts a car above its top speed, then bleeds back down', () => {
  const track = mkTrack(3);
  track.pads = [{ s: 8, lat: 0, radius: 1.0 }];
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 8, lat: 0, v: car.vmax }); // arrive at the pad at cruise
  let maxV = 0;
  for (let i = 0; i < 40; i++) { game.processInput('p1', { s: 0, b: 0 }); game.update(16); maxV = Math.max(maxV, car.v); }
  assert.ok(car.boostT >= 0, 'boost armed on the pad');
  assert.ok(maxV > car.vmax + 0.5, `boost lifts speed above vmax (peak ${maxV.toFixed(2)} vs vmax ${car.vmax})`);
  assert.ok(game.getSnapshot().cars[0].boostMul >= 1, 'snapshot exposes boostMul');
  // run past the boost; speed returns toward cruise with no boost left
  for (let i = 0; i < 120; i++) { game.processInput('p1', { s: 0, b: 0 }); game.update(16); }
  assert.equal(car.boostT, 0, 'boost expires');
  assert.ok(car.v <= car.vmax + 0.2, `speed settles back to cruise (v=${car.v.toFixed(2)})`);
});

test('catch-up: leader gets t=0, a trailing car gets a bigger pad boost', () => {
  const track = mkTrack(3);
  const L = track.length;
  track.pads = [{ s: L * 0.30, lat: 0, radius: 1.5 }, { s: L * 0.05, lat: 0, radius: 1.5 }];
  const game = new Game(['lead', 'back'], track, {});
  const lead = game.cars.get('lead'), back = game.cars.get('back');
  Object.assign(lead, { totalS: L * 0.30, lat: 0, v: lead.vmax });
  Object.assign(back, { totalS: L * 0.05, lat: 0, v: back.vmax });
  game.update(16); // computes t (lead/tail spread) then each car crosses its own pad
  assert.ok(Math.abs(lead.tRaw - 0) < 1e-9, `leader t = 0 (got ${lead.tRaw})`);
  assert.ok(back.tRaw > 0.9, `back-marker t near 1 (got ${back.tRaw.toFixed(2)})`);
  assert.ok(Math.abs(lead.boostMul - 1.25) < 1e-6, `leader gets the floor boost (got ${lead.boostMul})`);
  assert.ok(back.boostMul > lead.boostMul + 0.2, `trailing car gets a bigger boost (${back.boostMul.toFixed(2)} vs ${lead.boostMul.toFixed(2)})`);
});

test('catch-up: a lone car is treated as the leader (t=0)', () => {
  const track = mkTrack(3);
  const game = new Game(['solo'], track, {});
  Object.assign(game.cars.get('solo'), { totalS: 20 });
  game.update(16);
  assert.equal(game.cars.get('solo').tRaw, 0, 'a single car is never "behind"');
});

test('a boost pad fires once per cross (rising-edge), not every frame', () => {
  const track = mkTrack(3);
  track.pads = [{ s: 8, lat: 0, radius: 1.0 }];
  const game = new Game(['p1'], track, {});
  Object.assign(game.cars.get('p1'), { totalS: 8, lat: 0, v: 0 });
  const car = game.cars.get('p1');
  game.processInput('p1', { b: 1 }); game.update(16);
  assert.ok(car.boostT > 0, 'first cross arms a boost');
  for (let i = 0; i < 120; i++) { game.processInput('p1', { b: 1 }); game.update(16); }
  assert.equal(car.boostT, 0, 'the single boost expired');
  for (let i = 0; i < 30; i++) { game.processInput('p1', { b: 1 }); game.update(16); assert.equal(car.boostT, 0, 'parked on a pad does not re-arm'); }
});

test('an oil spin-out cancels an active boost (no banked re-burst)', () => {
  const track = mkTrack(3);
  track.hazards = [{ s: 8, lat: 0, radius: 1.0 }];
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 8, lat: 0, v: 8, boostT: 1.0, boostMul: 1.5 });
  game.update(16);
  assert.ok(car.spinT > 0, 'hit the slick');
  assert.equal(car.boostT, 0, 'boost is cancelled by the spin-out');
  assert.equal(car.boostMul, 1, 'boost multiplier reset');
});

// ---- item boxes + roll + use ------------------------------------------------

test('an item box fills the slot after the launch gate, then respawns', () => {
  const track = mkTrack(3);
  track.boxes = [{ s: 8, lat: 0, radius: 1.0 }];
  track.seed = 12345;
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 8, lat: 0, v: 0 });
  // before the launch gate: no pickup
  game.processInput('p1', { b: 1 }); game.update(16);
  assert.equal(car.item, null, 'no pickups during the launch window');
  // past the gate: pickup
  game.elapsed = 2;
  game.processInput('p1', { b: 1 }); game.update(16);
  assert.ok(car.item === 'boost' || car.item === 'banana', `box fills the slot (got ${car.item})`);
  assert.equal(game.getSnapshot().boxes[0], false, 'box is on cooldown after pickup');
  // respawn after BOX_RESPAWN
  for (let i = 0; i < 280; i++) { game.processInput('p1', { b: 1 }); game.update(16); } // ~4.5s
  assert.equal(game.getSnapshot().boxes[0], true, 'box respawns');
});

test('a freshly-rolled item is held through the reveal gate, then the buffered press fires', () => {
  const track = mkTrack(3);
  track.boxes = [{ s: 8, lat: 0, radius: 1.0 }];
  track.seed = 12345;
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 8, lat: 0, v: 0 });
  game.elapsed = 2; // past the launch gate
  game.processInput('p1', { b: 1 }); game.update(16); // roll an item from the box
  assert.ok(car.item, `box filled the slot (got ${car.item})`);
  // tap USE immediately: during the post-pickup reveal the press must BUFFER, not fire
  game.processInput('p1', { b: 1, u: 1 }); game.update(16);
  assert.ok(car.item, 'the item is NOT fired during the reveal gate');
  assert.ok(car.wantUse, 'the press is queued, waiting out the reveal gate');
  // hold the press; once the gate opens (~ITEM_USE_READY) the buffered press fires
  for (let i = 0; i < 70; i++) { game.processInput('p1', { b: 1, u: 1 }); game.update(16); }
  assert.equal(car.item, null, 'the buffered item fires once the reveal gate opens');
});

test('a full slot does not consume a box (it stays live for the next car)', () => {
  const track = mkTrack(3);
  track.boxes = [{ s: 8, lat: 0, radius: 1.0 }];
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 8, lat: 0, v: 0, item: 'boost' });
  game.elapsed = 2;
  game.update(16);
  assert.equal(game.getSnapshot().boxes[0], true, 'box not consumed while the slot is full');
});

test('item rolls are deterministic for a seed and position-weighted by t', () => {
  const track = mkTrack(3); track.seed = 999;
  const a = new Game(['x'], track, {}), b = new Game(['x'], track, {});
  const seqA = [], seqB = [];
  for (let i = 0; i < 20; i++) { seqA.push(a._roll(0.5)); seqB.push(b._roll(0.5)); }
  assert.deepEqual(seqA, seqB, 'same seed → identical roll sequence');
  // weighting: banana skews to the leader (t=0), boost to the back (t=1)
  const g = new Game(['x'], track, {});
  let bananaLeader = 0, bananaLast = 0;
  for (let i = 0; i < 4000; i++) if (g._roll(0) === 'banana') bananaLeader++;
  for (let i = 0; i < 4000; i++) if (g._roll(1) === 'banana') bananaLast++;
  assert.ok(bananaLeader > bananaLast + 400, `leader rolls more bananas than last (${bananaLeader} vs ${bananaLast})`);
});

test('the ACTION counter fires a use once per fresh value and dedups repeats', () => {
  const track = mkTrack(3);
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 8, lat: 0, v: 5, item: 'boost' });
  game.processInput('p1', { u: 1 });
  assert.ok(car.wantUse, 'a fresh counter value queues a use');
  game.update(16);
  assert.equal(car.item, null, 'the held item was used');
  assert.ok(car.boostT > 0, 'boost item armed a boost');
  assert.equal(car.wantUse, false, 'use consumed');
  game.processInput('p1', { u: 1 }); // repeat (e.g. fastlane re-delivery)
  assert.equal(car.wantUse, false, 'same counter value does not re-fire');
  game.processInput('p1', { u: 2 });
  assert.ok(car.wantUse, 'a new counter value fires again');
});

test('the first CONTROL frame (counter 0) does not ghost-fire a use', () => {
  // The controller resets its counter to 0 on stop(), and cars init useSeq:0, so the
  // opening frame's u=0 must NOT count as a press (otherwise a held item self-fires).
  const track = mkTrack(3);
  const game = new Game(['p1'], track, {});
  Object.assign(game.cars.get('p1'), { item: 'boost' });
  game.processInput('p1', { s: 0, b: 0, u: 0 });
  assert.equal(game.cars.get('p1').wantUse, false, 'u=0 on the first frame is not a fresh press');
});

test('a queued ACTION press survives a spin-out and fires on recovery', () => {
  const track = mkTrack(3);
  track.hazards = [{ s: 8, lat: 0, radius: 1.0 }];
  const game = new Game(['p1'], track, {});
  const car = game.cars.get('p1');
  Object.assign(car, { totalS: 8, lat: 0, v: 6, item: 'banana' });
  // tap USE the same frame we hit the slick: the press must buffer, not vanish
  game.processInput('p1', { u: 1 }); game.update(16);
  assert.ok(car.spinT > 0, 'spun out on entry');
  assert.equal(car.item, 'banana', 'the item was NOT consumed mid-spin');
  assert.ok(car.wantUse, 'the press is still queued');
  // run out the spin; the buffered press now fires
  for (let i = 0; i < 80; i++) { game.update(16); }
  assert.equal(car.item, null, 'the queued item fires once control returns');
  assert.equal(game.bananas.length, 1, 'the banana dropped after recovery');
});

test('an AI car uses items instead of hoarding (picks up then fires on a straight)', () => {
  const track = mkTrack(3);
  track.boxes = [{ s: 5, lat: 0, radius: 1.0 }];
  track.seed = 7;
  const game = new Game(['x'], track, {});
  game.elapsed = 2; // past the launch gate
  const car = game.cars.get('x');
  const bot = new AiController({ skill: 1 });
  let everHeld = false, everUsed = false;
  for (let i = 0; i < 400; i++) {
    game.processInput('x', bot.drive(car, track.centerline));
    game.update(16);
    if (car.item) everHeld = true;
    else if (everHeld) everUsed = true;
  }
  assert.ok(everHeld, 'AI picked up an item from the box');
  assert.ok(everUsed, 'AI used the item it was holding (did not hoard it forever)');
});

test('an AI bot steers around a hazard on its line instead of spinning out', () => {
  // Drive a bot straight at an oil slick parked on the centre line. With the engine
  // handed to drive() it sees the hazard and dodges; without it (control), it plows
  // through and spins — proving the evasion is what saves it, not luck.
  const runBot = (evade) => {
    const track = mkTrack(3);
    track.hazards = [{ s: 10, lat: 0, radius: 0.7 }];
    const game = new Game(['bot'], track, {});
    const bot = new AiController({ skill: 1, laneBias: 0, seed: 1 });
    const c = game.cars.get('bot');
    Object.assign(c, { totalS: 2, lat: 0, v: c.vmax });
    game._recomputePoses(); // pose at the assigned spot before the first steer
    game.elapsed = 5;
    let spun = false;
    for (let i = 0; i < 80 && c.totalS < 15; i++) { // up to the first corner
      game.processInput('bot', bot.drive(c, track.centerline, evade ? game : undefined));
      game.update(16);
      if (c.spinT > 0) spun = true;
    }
    return spun;
  };
  assert.equal(runBot(false), true, 'control: a bot with no hazard info plows through and spins');
  assert.equal(runBot(true), false, 'with evasion the bot steers around the slick and stays in control');
});

// ---- banana (dropped hazard) ------------------------------------------------

test('a dropped banana spins a follower (consumed on hit) but never the dropper', () => {
  const track = mkTrack(3);
  const game = new Game(['drop', 'follow'], track, {});
  const dropper = game.cars.get('drop'), follow = game.cars.get('follow');
  Object.assign(dropper, { totalS: 12, lat: 0, v: 0, item: 'banana' });
  Object.assign(follow, { totalS: 30, lat: 0, v: 0 }); // parked elsewhere, out of the way
  game.elapsed = 2;
  game.processInput('drop', { u: 1, b: 1 }); game.update(16);
  assert.equal(game.bananas.length, 1, 'banana dropped');
  const bs = game.bananas[0].s;
  // dropper sits on its own banana → never trips it (owner-skip), and it is NOT consumed
  Object.assign(dropper, { totalS: bs, v: 0 });
  for (let i = 0; i < 40; i++) { game.processInput('drop', { b: 1 }); game.update(16); }
  assert.equal(dropper.spinT, 0, 'the dropper never trips its own banana');
  assert.equal(game.bananas.length, 1, 'the owner sitting on it does not consume it');
  // a different car parks on the (now armed) banana → spins out AND consumes it
  Object.assign(follow, { totalS: bs, lat: 0, v: 0 });
  game.processInput('follow', { b: 1 }); game.update(16);
  assert.ok(follow.spinT > 0, 'a follower spins out on the banana');
  assert.equal(game.bananas.length, 0, 'the hit consumes the banana (Mario-Kart style)');
});

test('a dropped banana never expires — it waits on the track until hit', () => {
  const track = mkTrack(3);
  const game = new Game(['drop', 'follow'], track, {});
  Object.assign(game.cars.get('drop'), { totalS: 12, lat: 0, v: 0, item: 'banana' });
  Object.assign(game.cars.get('follow'), { totalS: 40, lat: 0, v: 0 }); // far away, never touches it
  game.elapsed = 2;
  game.processInput('drop', { u: 1, b: 1 }); game.update(16);
  assert.equal(game.bananas.length, 1, 'banana dropped');
  // both cars braked + parked clear of the banana; wait well past the old 12s timer
  for (let i = 0; i < 1500; i++) { // 24s — would have expired under the old life timer
    game.processInput('drop', { b: 1 }); game.processInput('follow', { b: 1 }); game.update(16);
  }
  assert.equal(game.bananas.length, 1, 'the banana is still there: no time-expiry');
});
