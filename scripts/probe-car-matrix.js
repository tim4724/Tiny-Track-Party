'use strict';
// Car × track lap-time matrix: run EACH car's stats (protocol.CAR_STATS) through
// EVERY track headlessly with the SAME AI driver, so the only variable is the car.
// The objective screen for stat tuning — read it for dominance (a car fastest
// everywhere), dead weight (a car slowest everywhere), and niche localisation
// (does the handling car win the tight tracks?). Lap time only covers accel/vmax/
// turn; MASS (collisions) is not measured here — validate that head-to-head.
// Usage: node scripts/probe-car-matrix.js
(async () => {
  const { buildTrack, TRACKS } = await import('../public/display/TrackBuilder.js');
  const { Game } = await import('../public/display/engine/Game.js');
  const { AiController, AI_PERSONALITIES } = await import('../public/display/AiDriver.js');
  const { CAR_STATS, CAR_NAMES } = require('../public/shared/protocol.js');

  const DT = 1000 / 60, LAPS = 4, MAX_S = 600;

  // Steady-state lap: run one car (stats) solo, average laps 2..N (drop the
  // standing-start lap so the comparison is per-lap pace, not launch).
  function lap(track, stats) {
    const engine = new Game([{ id: 0, stats }], track, { onEvent() {} });
    const bot = new AiController(AI_PERSONALITIES[0]);
    let t = 0, last = 0; const laps = [];
    while (!engine.raceOver && t < MAX_S) {
      const car = engine.cars.get(0);
      if (car && !car.finished && car.pose) engine.processInput(0, bot.drive(car, track.centerline));
      engine.update(DT); t += DT / 1000;
      const c = engine.cars.get(0);
      if (c && c.lap > last) { laps.push(t - laps.reduce((a, b) => a + b, 0)); last = c.lap; }
    }
    const steady = laps.slice(1);
    return steady.length ? steady.reduce((a, b) => a + b, 0) / steady.length : (laps[0] || 0);
  }

  const N = CAR_STATS.length;
  const pad = (s, n) => String(s).padStart(n);
  console.log('track'.padEnd(11) + 'len  ' + CAR_NAMES.map((n) => pad(n, 8)).join('') + '   spread winner');

  const wins = new Array(N).fill(0), rankSum = new Array(N).fill(0), worst = new Array(N).fill(0);
  let nTracks = 0;
  for (const name of Object.keys(TRACKS)) {
    const track = buildTrack(TRACKS[name]); track.totalLaps = LAPS;
    const times = CAR_STATS.map((s) => lap(track, s));
    const fast = Math.min(...times), slow = Math.max(...times);
    const wi = times.indexOf(fast), li = times.indexOf(slow);
    wins[wi]++; worst[li]++; nTracks++;
    times.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t).forEach((o, r) => { rankSum[o.i] += r + 1; });
    const cells = times.map((t, i) => (i === wi ? '*' : ' ') + t.toFixed(1).padStart(7)).join('');
    console.log(name.padEnd(11) + pad(track.length.toFixed(0), 3) + '  ' + cells +
      '  ' + pad(((slow - fast) / fast * 100).toFixed(1), 5) + '% ' + CAR_NAMES[wi]);
  }
  console.log('\nper-car summary (lower avgRank = faster overall; 1=always fastest, ' + N + '=always slowest):');
  CAR_NAMES.forEach((n, i) =>
    console.log(`  ${n.padEnd(8)} wins=${wins[i]}  worst=${worst[i]}  avgRank=${(rankSum[i] / nTracks).toFixed(2)}`));
})();
