'use strict';
// Packed-race car balance probe: run all four cars together on every track with
// collisions, items, hazards and traffic enabled. Every car rotates through every
// grid/personality slot once, so slot/lane bias is sampled without making the
// probe too slow for routine tuning. Use this alongside probe-car-matrix.js: the
// matrix measures clean lap pace; this measures whether weight and traffic pay off.
// Usage: node scripts/probe-packed-races.js
(async () => {
  const { buildTrack, TRACKS } = await import('../public/display/TrackBuilder.js');
  const { Game } = await import('../public/display/engine/Game.js');
  const { AiController } = await import('../public/display/AiDriver.js');
  const { CAR_STATS, CAR_NAMES } = require('../public/shared/protocol.js');

  const DT = 1000 / 60, LAPS = 3, MAX_S = 180;
  const LANES = [-0.6, 0.6, -0.25, 0.25];

  function rotations(xs) {
    return xs.map((_, i) => xs.slice(i).concat(xs.slice(0, i)));
  }

  function race(trackDef, order) {
    const track = buildTrack(trackDef);
    track.totalLaps = LAPS;
    const field = order.map((carIndex, slot) => ({
      id: carIndex,
      stats: CAR_STATS[carIndex],
      slot
    }));
    const engine = new Game(field.map((p) => ({ id: p.id, stats: p.stats })), track, { onEvent() {} });
    const bots = new Map(field.map((p) => [
      p.id,
      // Equal skill keeps the probe about car stats; the slot still changes lane/seed.
      new AiController({ skill: 1, laneBias: LANES[p.slot] || 0, seed: p.slot + 1 })
    ]));
    let t = 0;
    while (!engine.raceOver && t < MAX_S) {
      for (const p of field) {
        const car = engine.cars.get(p.id);
        if (car && !car.finished && car.pose) {
          engine.processInput(p.id, bots.get(p.id).drive(car, track.centerline, engine));
        }
      }
      engine.update(DT);
      t += DT / 1000;
    }
    return engine.getResults().results.map((r) => ({
      id: r.playerId,
      place: r.rank,
      time: r.time || MAX_S,
      finished: r.finished
    }));
  }

  const orders = rotations(CAR_STATS.map((_, i) => i));
  const totals = CAR_STATS.map(() => ({ wins: 0, rank: 0, dnfs: 0, races: 0 }));
  const pad = (s, n) => String(s).padStart(n);

  console.log('track'.padEnd(11) + ' winner   ' + CAR_NAMES.map((n) => pad(n, 8)).join(''));
  for (const [name, def] of Object.entries(TRACKS)) {
    const trackTotals = CAR_STATS.map(() => ({ wins: 0, rank: 0, dnfs: 0 }));
    for (const order of orders) {
      const results = race(def, order);
      for (const r of results) {
        const car = Number(r.id);
        trackTotals[car].rank += r.place;
        trackTotals[car].wins += r.place === 1 ? 1 : 0;
        trackTotals[car].dnfs += r.finished ? 0 : 1;
        totals[car].rank += r.place;
        totals[car].wins += r.place === 1 ? 1 : 0;
        totals[car].dnfs += r.finished ? 0 : 1;
        totals[car].races += 1;
      }
    }
    const winner = trackTotals
      .map((x, i) => ({ i, avg: x.rank / orders.length, wins: x.wins }))
      .sort((a, b) => a.avg - b.avg || b.wins - a.wins)[0].i;
    const cells = trackTotals.map((x) => (x.rank / orders.length).toFixed(2).padStart(8)).join('');
    console.log(name.padEnd(11) + CAR_NAMES[winner].padEnd(9) + cells);
  }

  console.log('\npacked-race summary (lower avgPlace = better):');
  CAR_NAMES.forEach((n, i) => {
    const t = totals[i];
    console.log(`  ${n.padEnd(8)} wins=${String(t.wins).padStart(3)}  avgPlace=${(t.rank / t.races).toFixed(2)}  dnfs=${t.dnfs}`);
  });
})();
