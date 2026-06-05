'use strict';
// Measure REAL lap times: build each track, run a single AI car (benchmark stats)
// through the engine headlessly, and report seconds/lap + a full 3-lap race time.
// This is the ground truth for "how long does a track take" — corner speed caps,
// braking, and hills all factor in, unlike a length/VMAX estimate.
// Usage: node scripts/probe-laptime.js
(async () => {
  const { buildTrack, TRACKS } = await import('../public/display/TrackBuilder.js');
  const { Game } = await import('../public/display/engine/Game.js');
  const { AiController, AI_PERSONALITIES } = await import('../public/display/AiDriver.js');

  const DT = 1000 / 60;        // fixed 60 Hz step
  const LAPS = 3;
  const MAX_S = 600;           // safety cap (sim seconds)

  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

  for (const name of Object.keys(TRACKS)) {
    const def = TRACKS[name];
    const track = buildTrack(def);
    track.totalLaps = LAPS;

    const engine = new Game([0], track, { onEvent() {} });
    const bot = new AiController(AI_PERSONALITIES[0]);

    let t = 0;
    const lapTimes = [];
    let lastLap = 0;
    while (!engine.raceOver && t < MAX_S) {
      const car = engine.cars.get(0);
      if (car && !car.finished && car.pose) engine.processInput(0, bot.drive(car, track.centerline));
      engine.update(DT);
      t += DT / 1000;
      const c = engine.cars.get(0);
      if (c && c.lap > lastLap) { lapTimes.push(t - (lapTimes.reduce((a, b) => a + b, 0))); lastLap = c.lap; }
    }
    const avg = lapTimes.length ? lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length : 0;
    console.log(
      `${name.padEnd(11)} len=${track.length.toFixed(0).padStart(3)}  ` +
      `lap≈${avg.toFixed(1).padStart(5)}s  race(${LAPS})≈${fmt(t).padStart(5)}  ` +
      `laps=[${lapTimes.map((x) => x.toFixed(1)).join(', ')}]`
    );
  }
})();
