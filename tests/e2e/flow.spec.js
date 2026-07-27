// @ts-check
// Core session flow: lobby → ready/start → countdown → racing → pause →
// "New game" → back to the lobby, asserted across the display and both phones.
const { test, expect, openDisplay, joinController, startRace, waitForRacing, visible } = require('./helpers');

test('lobby → race → pause → new game returns everyone to the lobby', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice'); // first in → host
  const bob = await joinController(browser, roomCode, 'Bob');
  await expect(page.locator('#players')).toContainText('Alice');
  await expect(page.locator('#players')).toContainText('Bob');

  // Bob readies up: his car pick locks (strip tiles disabled) until he
  // un-readies — the ready button is a toggle.
  await bob.click('#ready-btn');
  await expect(bob.locator('#ready-btn')).toHaveClass(/is-pressed/);
  await expect(bob.locator('.car-opt').first()).toBeDisabled();
  await bob.click('#ready-btn');
  await expect(bob.locator('#ready-btn')).not.toHaveClass(/is-pressed/);
  await expect(bob.locator('.car-opt').first()).toBeEnabled();

  // Record every retained-state snapshot the display publishes from here on, in
  // order, and note who's seated — so we can prove the race's FIRST snapshot
  // already marks them as racing (regression guard below).
  await page.evaluate(() => {
    window.__snaps = [];
    const p = window.__net.party, orig = p.setState.bind(p);
    p.setState = (payload) => { window.__snaps.push(JSON.parse(JSON.stringify(payload))); return orig(payload); };
  });
  const seated = await page.evaluate(() => window.__net.flow.list().filter((p) => p.connected).map((p) => p.peerIndex));

  await startRace(alice, [bob]);

  // Display flips to the race, phones get the drive HUD, countdown reaches GO.
  await page.waitForSelector(visible('#race'));
  await alice.waitForSelector(visible('#game'));
  await bob.waitForSelector(visible('#game'));
  await waitForRacing(page);

  // The COUNTDOWN snapshot must ALREADY list every seated player inRace. The bug:
  // the display flipped to COUNTDOWN before the race session existed, so inRace
  // (read from session.hasCar) came out false for everyone and phones flashed the
  // "you're in the next race" waiting screen for the whole countdown. A #game wait
  // can't catch that — it just resolves late, at GO. So assert on the wire: no
  // mid-race snapshot may show a seated racer as inRace:false.
  const midRace = await page.evaluate((seated) => {
    const mid = window.__snaps.filter((s) => s.roomState === 'countdown' || s.roomState === 'playing');
    const offenders = mid.flatMap((s) => (s.players || [])
      .filter((pl) => seated.includes(pl.peerIndex) && pl.inRace === false)
      .map((pl) => ({ roomState: s.roomState, peerIndex: pl.peerIndex })));
    // The very first mid-race snapshot IS the countdown one — prove it exists and
    // already marks everyone in, so the assertion can't pass vacuously.
    const firstCountdownOk = mid.length > 0 && mid[0].roomState === 'countdown'
      && seated.every((i) => mid[0].players.some((pl) => pl.peerIndex === i && pl.inRace === true));
    return { offenders, firstCountdownOk };
  }, seated);
  expect(midRace.offenders).toEqual([]);
  expect(midRace.firstCountdownOk).toBe(true);

  // The HUD sits on the cells the RENDERER drew. Stage.js has no split-screen
  // layout of its own any more — it asks (ttp_display_cell_rects, one function
  // with the renderer's own viewport split) and scales the answer out of
  // drawing-buffer pixels by its DPR. That scale is the whole risk in the swap:
  // this suite runs on the 0.25 automation cap, so a missing division puts every
  // label at a quarter of its cell and a doubled one puts it off-screen.
  const layout = await page.evaluate(() => {
    const s = window.__scene;
    const cells = [];
    const packed = s.display.cellRects(8);
    for (let i = 0; i < packed.length; i += 4) {
      cells.push({ x: packed[i], y: packed[i + 1], w: packed[i + 2], h: packed[i + 3] });
    }
    const px = (el, p) => parseFloat(el.style[p]);
    return {
      dpr: s._dpr,
      canvas: { w: s._canvas.width, h: s._canvas.height },
      view: { w: window.innerWidth, h: window.innerHeight },
      cells,
      labels: [...document.querySelectorAll('.cell-label')].map((el) => [px(el, 'left'), px(el, 'top')]),
      steers: [...document.querySelectorAll('.cell-steer')].map((el) => [px(el, 'left'), px(el, 'top')]),
      dividers: document.querySelectorAll('.cell-divider').length
    };
  });
  // Two racers, two cells, and they tile the drawing buffer: same size, and the
  // grid spends the surface bar the whole-pixel remainder.
  expect(layout.cells).toHaveLength(2);
  expect(layout.cells[0].w).toBe(layout.cells[1].w);
  expect(layout.cells[0].h).toBe(layout.cells[1].h);
  expect(layout.cells[0]).toMatchObject({ x: 0, y: 0 });
  const spanX = Math.max(...layout.cells.map((c) => c.x + c.w));
  const spanY = Math.max(...layout.cells.map((c) => c.y + c.h));
  expect(spanX).toBeLessThanOrEqual(layout.canvas.w);
  expect(spanY).toBeLessThanOrEqual(layout.canvas.h);
  expect(layout.canvas.w - spanX).toBeLessThan(2); // cols-1 px at most, cols <= 2 here
  expect(layout.canvas.h - spanY).toBeLessThan(2);
  // …and every label is at its cell's top-left corner IN CSS PIXELS, with the
  // steer bar centred on the same cell. Compared as a set, since DOM order is
  // creation order rather than cell order, and with Stage.js's own arithmetic
  // (scale first, then offset) so this compares the layout, not two roundings.
  const k = 1 / layout.dpr;
  const css = layout.cells.map((c) => ({ x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k }));
  const corners = css.map((r) => `${r.x},${r.y}`).sort();
  const middles = css.map((r) => `${r.x + r.w / 2},${r.y + r.h - 61}`).sort();
  expect(layout.labels.map((p) => p.join(',')).sort()).toEqual(corners);
  expect(layout.steers.map((p) => p.join(',')).sort()).toEqual(middles);
  // The cells fill the screen the HUD lays out on, so a label is never stranded
  // in the corner of a quarter-sized grid (the un-scaled failure).
  expect(spanX * k).toBeGreaterThan(layout.view.w - 4);
  expect(spanY * k).toBeGreaterThan(layout.view.h - 4);
  // One ink rule per interior seam: 1x2 here, so exactly one.
  expect(layout.dividers).toBe(1);

  // Any phone can pause; the overlay raises on every screen.
  await bob.click('#pause-btn');
  await bob.waitForSelector(visible('#pause-overlay'));
  await alice.waitForSelector(visible('#pause-overlay'));
  await page.waitForSelector(visible('#pause-overlay'));

  // "New game" from the pause overlay aborts the race back to the lobby.
  await bob.click('#pause-newgame');
  await page.waitForSelector(visible('#lobby'));
  await alice.waitForSelector(visible('#lobby'));
  await bob.waitForSelector(visible('#lobby'));
  // The race was actually torn down, not just visually hidden: the display disposed
  // its session (timers + scene cars), so __session() is null back in the lobby.
  await page.waitForFunction(() => window.__session() === null);

  // Ready survives the round trip: Bob is still ready (car pick still locked),
  // so the host's "Start race" is immediately armed for the next race.
  await expect(bob.locator('#ready-btn')).toHaveClass(/is-pressed/);
  await expect(bob.locator('.car-opt').first()).toBeDisabled();
  await expect(alice.locator('#ready-btn')).toBeEnabled();
});
