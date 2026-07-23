'use strict';
// The dev-only Gym collision-test track (shared/devTracks.js) + the debug hooks
// it leans on: forceItem (?item=<id> — every box roll returns that item) and
// authored, respawning bananas (track.bananas → seeded live, box-style cooldown
// after a hit). A pure-pursuit car drives the centreline through each cluster
// and must trip every trigger type in authored order.
const test = require('node:test');
const assert = require('node:assert/strict');

let buildTrack, resolveFurniture, Game, DEV_TRACKS, Vec3;
test.before(async () => {
  ({ buildTrack, resolveFurniture } = await import('../public/display/TrackBuilder.js'));
  ({ Game } = await import('../public/display/engine/Game.js'));
  ({ DEV_TRACKS } = await import('../public/shared/devTracks.js'));
  Vec3 = (await import('../public/display/engine/Vec3.js')).Vec3;
});

// Resolve the authored furniture via the SAME shared resolver the display uses
// (fraction-of-lap u → arclength s; default radii from the road width).
function buildGym() {
  const b = resolveFurniture(buildTrack(DEV_TRACKS.gym), DEV_TRACKS.gym);
  b.totalLaps = 9;
  return b;
}

// Pure pursuit with a lane offset: aim at the centreline point ahead, shifted
// `latTarget` along the track's lateral vector — how a human holds a lane.
function followSteer(game, track, id, latTarget = 0) {
  const c = game.cars.get(id);
  const snap = game.getSnapshot().cars.find((x) => x.id === id);
  const frame = track.centerline.sampleAt(c.totalS + 3);
  const look = frame.pos.clone().addScaledVector(frame.lateral, latTarget);
  const d = look.sub(snap.pose.pos).normalize();
  // The snapshot pose is plain data (no vector methods) — lift forward into a Vec3.
  const fwd = new Vec3(snap.pose.forward.x, snap.pose.forward.y, snap.pose.forward.z);
  const err = Math.atan2(fwd.clone().cross(d).dot(snap.pose.up), fwd.dot(d));
  return Math.max(-1, Math.min(1, -err * 3));
}

test('gym: a centreline lap trips box → oil → banana, forceItem rolls monster, bananas respawn', () => {
  const track = buildGym();
  const game = new Game(['p1'], track, {});
  game.forceItem = 'monster';
  const events = [];
  game.onEvent = (ev) => events.push(ev);

  const c = game.cars.get('p1');
  const seeded = game.bananas.length;
  assert.equal(seeded, 3, 'authored bananas are seeded live at race start');

  // One full lap on the centreline (~232 units): pure pursuit hugs lat 0, so the
  // ±1.0 pole gate is threaded and the lat-0 props all trip — except the
  // dead-centre pole (s≈52), which the lane plan dodges like a player would.
  const laneAt = (s) => (s > 45 && s < 60 ? 0.9 : 0);
  let bananaHitAt = null;
  for (let i = 0; i < 4000 && c.lap < 1; i++) {
    game.processInput('p1', { s: followSteer(game, track, 'p1', laneAt(c.totalS % track.length)), b: 0 });
    game.update(16);
    if (bananaHitAt === null && events.some((e) => e.type === 'spin' && e.cause === 'banana')) {
      bananaHitAt = game.elapsed;
      assert.equal(game.bananas.length, seeded, 'a hit authored banana rearms instead of despawning');
      const hidden = game.getSnapshot().bananas.length;
      assert.equal(hidden, seeded - 1, 'a rearming banana is hidden from the snapshot while it cools down');
    }
  }
  assert.ok(c.lap >= 1, 'completed the lap on pure pursuit');

  const pickups = events.filter((e) => e.type === 'pickup');
  assert.ok(pickups.length >= 1, 'drove over the centreline item box');
  assert.ok(pickups.every((p) => p.item === 'monster'), 'forceItem makes every roll a monster');
  assert.ok(events.some((e) => e.type === 'spin' && e.cause === 'oil'), 'centre oil puddle spun the car');
  assert.ok(bananaHitAt !== null, 'centre banana spun the car');
  assert.equal(game.getSnapshot().bananas.length, seeded, 'the crushed banana respawned after its cooldown');
});

test('gym: box pickup is point-based with the tuned 0.45 radius — same reach for every car', () => {
  const track = buildGym();
  const game = new Game(['p1'], track, {});
  game.forceItem = 'monster';
  const c = game.cars.get('p1');
  const box = game.boxes[0]; // the isolated centreline box, radius 0.45
  // Park the car's CENTRE at a lateral offset from the box and poll the trigger
  // directly; reset the latches + cooldown between probes.
  const grab = (lat) => {
    c.totalS = box.s; c.lat = lat; c.heading = 0; c.spin = 0;
    c.item = null; c.boxIn.clear(); c.rowIn.clear(); box.cooldown = 0;
    game._enterBox(c);
    return c.item;
  };
  assert.ok(Math.abs(box.radius - 0.45) < 1e-9, 'sanity: 9% of the 5-wide road');
  assert.equal(grab(0.40), 'monster', 'centre inside the tuned radius — grab');
  assert.equal(grab(0.50), null, 'centre outside — no grab');
  // The car is a point BY DESIGN: reach is identical for every footprint, so a
  // monster truck grabs exactly what a normal car grabs — no footprint creep.
  c.monsterT = 5;
  assert.equal(grab(0.50), null, 'monster reach is unchanged (point test ignores footprint)');
});
