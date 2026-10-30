// @ts-check
// The landmark gallery's scene (/gallery-landmarks.html drives it through
// window.__landmarks). The look of each pose is judged by eye on the page; this
// pins what an eye cannot be asked to notice going away: the set layout
// reaching the page, the lap score, the split following the seats, every view
// switching on a scene that keeps drawing, each cell's camera being a real
// pose that has its landmark in the lens, the driver views parking every
// cell's car at a spot of its own on level, upright road with its own car in
// shot (and the framed views parking none), and the pinned render scale.
const { test, expect } = require('./helpers');

const frames = (page, n) => page.evaluate((k) => new Promise((resolve) => {
  let left = k;
  window.__scene.onAfterFrame = () => { if (--left <= 0) { window.__scene.onAfterFrame = null; resolve(); } };
}), n);

// Per cell: is the framed piece's footprint centre inside the pose's horizontal
// lens? The renderer may only widen a cell's lens, so inside here is inside on
// screen.
const inLens = (page) => page.evaluate(() => {
  const lay = window.__landmarks.layout();
  return window.__landmarks.poses().map((q) => {
    const p = lay.pieces[q.piece];
    const half = Math.atan(Math.tan((q.fov / 2) * Math.PI / 180) * q.aspect);
    const fwd = Math.atan2(q.target.x - q.eye.x, q.target.z - q.eye.z);
    const to = Math.atan2(p.cx - q.eye.x, p.cz - q.eye.z);
    return Math.abs(Math.atan2(Math.sin(to - fwd), Math.cos(to - fwd))) < half;
  });
});
const poses = (page) => page.evaluate(() => window.__landmarks.poses());
// Per cell: is its own parked car inside the pose's horizontal lens? A cell
// that turns its camera onto a piece off to the side must not turn away from it.
const carInLens = (page) => page.evaluate(() => {
  const L = window.__landmarks;
  const ps = L.poses();
  const fr = window.__scene.display.trackFrames(L.trackId(), ps.map((q) => q.car.s));
  return ps.map((q, k) => {
    const f = fr[k];
    const x = f.pos.x + f.lateral.x * q.car.lat, z = f.pos.z + f.lateral.z * q.car.lat;
    const half = Math.atan(Math.tan((q.fov / 2) * Math.PI / 180) * q.aspect);
    const fwd = Math.atan2(q.target.x - q.eye.x, q.target.z - q.eye.z);
    const to = Math.atan2(x - q.eye.x, z - q.eye.z);
    return Math.abs(Math.atan2(Math.sin(to - fwd), Math.cos(to - fwd))) < half;
  });
});
// The driver poses' parking, against the page's own rules: per cell whether the
// road under its car is upright and near level, and the closest two cars in
// one lane come along the road (Infinity with one car a lane).
const parking = (page) => page.evaluate(() => {
  const L = window.__landmarks;
  const { upright, level } = L.rules();
  const cars = L.poses().map((q) => q.car);
  const fr = window.__scene.display.trackFrames(L.trackId(), cars.map((c) => c.s));
  const len = L.layout().length;
  let closest = Infinity;
  cars.forEach((a, i) => cars.slice(i + 1).forEach((b) => {
    if (Math.sign(a.lat) !== Math.sign(b.lat)) return;
    const d = Math.abs(a.s - b.s) % len;
    closest = Math.min(closest, d, len - d);
  }));
  return { upright: fr.map((f) => f.up.y >= upright && Math.abs(f.tangent.y) <= level), closest };
});
const finite = (q) => [q.eye.x, q.eye.y, q.eye.z, q.target.x, q.target.y, q.target.z, q.fov]
  .every(Number.isFinite) && q.fov > 0;

test('landmark gallery: layout, split and every view', async ({ page }) => {
  // A named scale, as the gallery page passes one: the buffer is the stage's
  // own height at that scale, whatever the adaptive rule would have done.
  await page.goto('/?scenario=landmarks&track=tidepool&players=2&dpr=0.5');
  await page.waitForFunction(() => window.__landmarks, null, { timeout: 30000 });
  await page.evaluate(() => window.__landmarks.ready());
  expect(await page.evaluate(() => window.__landmarks.lines()))
    .toBe(await page.evaluate(() => Math.round(window.__scene.container.clientHeight * 0.5)));

  const layout = await page.evaluate(() => window.__landmarks.layout());
  expect(layout.length).toBeGreaterThan(0);
  expect(layout.pieces.length).toBeGreaterThan(0);
  for (const p of layout.pieces) expect(p.model).toMatch(/^set-/);
  // Each piece's meshes, which the sight lines test against.
  for (const p of layout.pieces) expect(p.parts.length).toBeGreaterThan(0);
  // The beach's palms and boulders, which they test against too.
  const scatter = await page.evaluate(() => window.__scene.display.scatterLayout());
  expect(scatter.length).toBeGreaterThan(0);
  for (const row of scatter) expect(row.length).toBe(4);
  // One entry per model, every placement counted.
  const marks = await page.evaluate(() => window.__landmarks.landmarks());
  expect(new Set(marks.map((m) => m.model)).size).toBe(marks.length);
  expect(marks.reduce((n, m) => n + m.count, 0)).toBe(layout.pieces.length);

  // The lap score: a lap was driven, every piece has a row, and its clean
  // seconds are seconds it spent in the lens.
  const score = await page.evaluate(() => window.__landmarks.score());
  expect(score.lap).toBeGreaterThan(0);
  expect(score.pieces.map((p) => p.model)).toEqual(layout.pieces.map((p) => p.model));
  for (const p of score.pieces) {
    expect(p.seen).toBeLessThanOrEqual(p.lens);
    expect(p.small + p.hidden + p.roof).toBeLessThanOrEqual(p.lens + 0.1);
    // no road runs through a piece or over it (`npm run place:landmarks` moves one that does)
    expect(['road', 'deck'], `${p.label} clashes`).not.toContain(p.spot);
  }
  // Every static part of every piece took the bake: nothing still is left
  // drawing live-lit. The scene budget gates the same answer per track, but
  // nothing runs it unasked.
  expect(await page.evaluate(() => window.__scene.display.debugLiveDressing())).toEqual({});

  const cells = () => page.evaluate(() => window.__scene.cellBoxes().length);
  expect(await cells()).toBe(2);
  await page.evaluate(() => window.__landmarks.players(4));
  expect(await cells()).toBe(4);

  for (const view of ['driver', 'glance', 'high', 'orbit', 'top', 'race', 'free']) {
    expect(await page.evaluate((v) => window.__landmarks.view(v), view)).toBe(view);
    await frames(page, 2);
    // Free is one full view; every other mode keeps the seats' cells.
    expect(await cells()).toBe(view === 'free' ? 0 : 4);
    const got = await poses(page);
    if (view === 'race' || view === 'free') expect(got).toEqual([]);
    else {
      expect(got.length).toBe(4);
      for (const q of got) expect(finite(q)).toBe(true);
      // Driver and glance park the cars on the approach; the framed views
      // leave them on the grid.
      for (const q of got) expect(!!q.car).toBe(view === 'driver' || view === 'glance');
    }
  }
  // Leaving free hands the page back: no drag-through class left behind.
  await page.evaluate(() => window.__landmarks.view('driver'));
  expect(await page.evaluate(() => document.documentElement.classList.contains('cam-free'))).toBe(false);

  // The approach and the glance have their landmark in shot, and the framed
  // views stand somewhere else than the driver. Driver is the parked car's own
  // chase rig, and four cells on one landmark are four drivers' approaches:
  // no two cars parked on the same spot.
  expect(await inLens(page)).toEqual([true, true, true, true]);
  const driver = await poses(page);
  for (const q of driver) expect(Number.isFinite(q.car.s) && Number.isFinite(q.car.lat)).toBe(true);
  expect(new Set(driver.map((q) => `${q.car.s}:${q.car.lat}`)).size).toBe(4);
  expect(driver.every((q) => q.piece === driver[0].piece)).toBe(true);
  await page.evaluate(() => window.__landmarks.view('glance'));
  expect(await inLens(page)).toEqual([true, true, true, true]);
  for (const [i, q] of (await poses(page)).entries()) expect(q.fov).toBeLessThanOrEqual(driver[i].fov);
  for (const view of ['high', 'orbit']) {
    await page.evaluate((v) => window.__landmarks.view(v), view);
    for (const [i, q] of (await poses(page)).entries()) expect(q.eye).not.toEqual(driver[i].eye);
  }
  await page.evaluate(() => window.__landmarks.spread(true));
  await page.evaluate(() => window.__landmarks.focus(1));
  expect(await page.evaluate(() => window.__landmarks.view('high'))).toBe('high');
  await frames(page, 2);
  expect(await cells()).toBe(4);
  // Spread: each cell its own landmark, each in the driver's lens.
  await page.evaluate(() => window.__landmarks.view('driver'));
  const spread = await poses(page);
  expect(new Set(spread.map((q) => q.piece)).size).toBe(Math.min(4, marks.length));
  expect(await inLens(page)).toEqual([true, true, true, true]);
  await page.evaluate(() => window.__landmarks.spread(false));
  await expect(page.evaluate(() => window.__landmarks.view('nope'))).rejects.toThrow(/unknown landmark view/);

  // Race drives: the field leaves the grid.
  await page.evaluate(() => window.__landmarks.view('race'));
  const at = () => page.evaluate(() => window.__engine.getSnapshot().cars.map((c) => c.pose.pos.x + c.pose.pos.z));
  const before = await at();
  await frames(page, 20);
  expect(await at()).not.toEqual(before);
  await page.evaluate(() => window.__landmarks.view('driver'));

  // Pretzel's landmarks sit past bends, where a short walk back finds no road
  // that shows them: every one of them in the driver's lens with each cell's
  // own car, and its cars parked apart (at least half a car gap in one lane),
  // in 2P and 4P cells.
  await page.evaluate(() => window.__landmarks.track('pretzel'));
  const { carGap } = await page.evaluate(() => window.__landmarks.rules());
  const n = await page.evaluate(() => window.__landmarks.landmarks().length);
  expect(n).toBeGreaterThan(0);
  for (const seats of [2, 4]) {
    await page.evaluate((k) => window.__landmarks.players(k), seats);
    for (let i = 0; i < n; i++) {
      await page.evaluate((k) => window.__landmarks.focus(k), i);
      expect(await inLens(page)).toEqual(Array(seats).fill(true));
      expect(await carInLens(page)).toEqual(Array(seats).fill(true));
      expect((await parking(page)).closest).toBeGreaterThanOrEqual(carGap / 2 - 1e-6);
    }
  }

  // Riptide's lifeguard tower stands inland on its dune bank, in no stretch's
  // lens: every cell turns onto it, each from its own distance, each keeping
  // its own car in shot.
  await page.evaluate(() => window.__landmarks.track('riptide'));
  await page.evaluate(() => window.__landmarks.focus(0));
  expect(await carInLens(page)).toEqual([true, true, true, true]);
  expect(new Set((await poses(page)).map((q) => q.car.s)).size).toBe(4);

  // Skysnake's landmarks stand by loops and steep ramps: no car parks on one.
  await page.evaluate(() => window.__landmarks.track('skysnake'));
  const m = await page.evaluate(() => window.__landmarks.landmarks().length);
  for (let i = 0; i < m; i++) {
    await page.evaluate((k) => window.__landmarks.focus(k), i);
    expect((await parking(page)).upright).toEqual([true, true, true, true]);
  }

  // Still drawing at the end of it all.
  expect(await page.evaluate(() => window.__scene.display.built)).toBe(true);
  await frames(page, 3);
});

// The page pins the stage's render scale (Sharp, the default) so a rebuild's
// missed frames cannot step the picture down, and Auto hands it back to the
// game's adaptive rule; either is a reload of the stage, remembered.
test('landmark gallery page: the Res toggle', async ({ page }) => {
  await page.goto('/gallery-landmarks.html');
  const src = () => page.evaluate(() => new URL(document.getElementById('lm-stage').src).searchParams.get('dpr'));
  // The panel's own scale, under the stage's height cap.
  const sharp = await page.evaluate(async () => {
    const { MAX_BUFFER_H } = await import('/display/Stage.js');
    const h = document.getElementById('lm-stage').clientHeight;
    return Math.min(window.devicePixelRatio || 1, MAX_BUFFER_H / h);
  });
  expect(Math.abs(Number(await src()) - sharp)).toBeLessThan(1e-3);
  await expect(page.locator('#lm-res')).toHaveText('Res: Sharp');
  await page.click('#lm-res');
  await expect(page.locator('#lm-res')).toHaveText('Res: Auto');
  expect(await src()).toBeNull();
  await page.reload();
  await expect(page.locator('#lm-res')).toHaveText('Res: Auto');
  expect(await src()).toBeNull();
});
