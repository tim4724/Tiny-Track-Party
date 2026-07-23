'use strict';
// Cross-layer config drift guards. The engine (public/display/engine/Game.js) must
// stay dependency-free (portable purity), so a few shared-in-concept constants are
// duplicated there as fallbacks rather than imported from shared/protocol.js. These
// tests are the tripwire: if the protocol-side value moves, the engine fallback must
// move in the same commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../public/shared/protocol.js');

let Game, buildTrack;
test.before(async () => {
  ({ Game } = await import('../public/display/engine/Game.js'));
  ({ buildTrack } = await import('../public/display/TrackBuilder.js'));
});

const L = 4.0, RL = 4.185;
const straight = (length) => ({ kind: 'straight', length });
const arc = (radius, angle) => ({ kind: 'arc', radius, angle });
const OVAL = [
  straight(L * 6), arc(RL, 90), straight(L * 2), arc(RL, 90),
  straight(L * 6), arc(RL, 90), straight(L * 2), arc(RL, 90)
];

test('engine totalLaps fallback matches protocol TOTAL_LAPS', () => {
  const track = buildTrack(OVAL); // no totalLaps on the track → the engine default applies
  const game = new Game(['p1'], track, {});
  assert.equal(game.totalLaps, protocol.TOTAL_LAPS,
    'Game.js `track.totalLaps || N` fallback drifted from protocol.TOTAL_LAPS');
});

test('engine benchmark collision footprint matches the protocol reference car', () => {
  // A stats-less car gets the engine benchmark (DEFAULT_STATS). protocol.CAR_STATS
  // holds the per-model footprints measured from the Kenney meshes; index 0 (Dash)
  // is the reference body both sides were authored against.
  const game = new Game(['p1'], buildTrack(OVAL), {});
  const c = game.cars.get('p1');
  const ref = protocol.carStats(0);
  assert.equal(c.halfLen, ref.halfLen, 'engine DEFAULT_STATS.halfLen drifted from protocol.CAR_STATS[0]');
  assert.equal(c.halfWid, ref.halfWid, 'engine DEFAULT_STATS.halfWid drifted from protocol.CAR_STATS[0]');
});
