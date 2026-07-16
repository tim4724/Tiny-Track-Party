'use strict';
// The dev-only Gym collision-test track (shared/devTracks.js) + the debug hooks
// it leans on: forceItem (?item=<id> — every box roll returns that item) and
// authored, respawning bananas (track.bananas → seeded live, box-style cooldown
// after a hit). A pure-pursuit car drives the centreline through each cluster
// and must trip every trigger type in authored order.
const test = require('node:test');
const assert = require('node:assert/strict');

let buildTrack, Game, DEV_TRACKS;
test.before(async () => {
  buildTrack = (await import('../public/display/TrackBuilder.js')).buildTrack;
  ({ Game } = await import('../public/display/engine/Game.js'));
  ({ DEV_TRACKS } = await import('../public/shared/devTracks.js'));
});

// Resolve the authored furniture exactly like the display's buildEntry
// (fraction-of-lap u → arclength s; default radii from the road width).
function buildGym() {
  const t = DEV_TRACKS.gym;
  const b = buildTrack(t);
  const u2s = (u) => (((u % 1) + 1) % 1) * b.length;
  b.hazards = (t.oils || []).map((o) => ({ s: u2s(o.u), lat: o.lat || 0, radius: b.roadWidth * 0.2 }));
  b.boxes = (t.boxes || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: b.roadWidth * 0.06 }));
  b.poles = (t.poles || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0, radius: 0.45 }));
  b.bananas = (t.bananas || []).map((p) => ({ s: u2s(p.u), lat: p.lat || 0 }));
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
  const err = Math.atan2(snap.pose.forward.clone().cross(d).dot(snap.pose.up), snap.pose.forward.dot(d));
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

test('gym: box pickup is body-touch — reach comes from the car footprint, monster reaches further', () => {
  const track = buildGym();
  const game = new Game(['p1'], track, {});
  game.forceItem = 'monster';
  const c = game.cars.get('p1');
  const box = game.boxes[0]; // the isolated centreline box, radius 0.3
  // Park the body beside the box (yaw 0 → lateral reach = halfWid) and poll the
  // trigger directly; reset the latches + cooldown between probes.
  const grab = (lat) => {
    c.totalS = box.s; c.lat = lat; c.heading = 0; c.spin = 0;
    c.item = null; c.boxIn.clear(); c.rowIn.clear(); box.cooldown = 0;
    game._enterBox(c);
    return c.item;
  };
  // Normal car: halfWid 0.26 + box 0.3 → lateral reach 0.56.
  assert.equal(grab(0.66), null, 'daylight between body and box — no grab');
  assert.equal(grab(0.46), 'monster', 'doors touch the box — grab');
  // Monster truck: halfWid ×1.3 → reach ≈ 0.64. Same offsets, wider body.
  c.monsterT = 5;
  assert.equal(grab(0.66), null, 'still daylight even for the monster');
  assert.equal(grab(0.60), 'monster', 'the widened monster footprint reaches what a car cannot');
});
