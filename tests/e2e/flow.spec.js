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
    // The retained snapshot is composed AND FRAMED in C++ now
    // (ttp_net_lobby_frame), so the display publishes pre-encoded bytes through
    // setStateFrame rather than handing setState an object. Unwrap the frame to
    // get back the same snapshot this hook has always collected.
    const p = window.__net.party, orig = p.setStateFrame.bind(p);
    p.setStateFrame = (frame) => { window.__snaps.push(JSON.parse(frame).data); return orig(frame); };
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
      ranks: [...document.querySelectorAll('.cell-rank')].map((el) => [px(el, 'left'), px(el, 'top')])
    };
  });
  // Two racers, two cells, same size, tiling a grid that starts at the TOP of
  // the drawing buffer and is centred across it. Not `x: 0`: a stacked pair is
  // the one small-party grid whose tiles fall outside the aspect band, so the
  // renderer fits the grid as ONE piece (TtpRenderer::cellRect) and the
  // bars it leaves land at the screen's two edges rather than as a seam through
  // the layout. Assert THAT — equal bars, whole-pixel remainder — instead of an
  // origin, so this reads the same on a surface where nothing is capped.
  expect(layout.cells).toHaveLength(2);
  expect(layout.cells[0].w).toBe(layout.cells[1].w);
  expect(layout.cells[0].h).toBe(layout.cells[1].h);
  expect(layout.cells[0].y).toBe(0);
  const barL = Math.min(...layout.cells.map((c) => c.x));
  const spanX = Math.max(...layout.cells.map((c) => c.x + c.w));
  const spanY = Math.max(...layout.cells.map((c) => c.y + c.h));
  expect(spanX).toBeLessThanOrEqual(layout.canvas.w);
  expect(spanY).toBeLessThanOrEqual(layout.canvas.h);
  // cols-1 px at most either side of centre, cols <= 2 here
  expect(Math.abs(layout.canvas.w - spanX - barL)).toBeLessThan(2);
  expect(layout.canvas.h - spanY).toBeLessThan(2);
  // …and every label is at its cell's top-left corner IN CSS PIXELS, with the
  // place/lap readout on the same cell's top-RIGHT (so the width is scaled too,
  // not just the origin). Compared as a set, since DOM order is creation order
  // rather than cell order, and with Stage.js's own arithmetic (scale first,
  // then offset) so this compares the layout, not two roundings.
  const k = 1 / layout.dpr;
  const css = layout.cells.map((c) => ({ x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k }));
  const corners = css.map((r) => `${r.x},${r.y}`).sort();
  const rights = css.map((r) => `${r.x + r.w - 12},${r.y + 11}`).sort();
  expect(layout.labels.map((p) => p.join(',')).sort()).toEqual(corners);
  expect(layout.ranks.map((p) => p.join(',')).sort()).toEqual(rights);
  // The cells fill the screen the HUD lays out on, so a label is never stranded
  // in the corner of a quarter-sized grid (the un-scaled failure). Height is
  // never capped, so it is the exact check; across the width it is the grid PLUS
  // the two letterbox bars that reaches both edges.
  expect(spanY * k).toBeGreaterThan(layout.view.h - 4);
  expect((spanX + barL) * k).toBeGreaterThan(layout.view.w - 4);

  // The steer bar and the cell dividers are no longer DOM: they are drawn by the
  // renderer (cell-anchored and textless, so they need no UI toolkit), which
  // means the assertion they used to carry has to be made in the PIXELS. It
  // proves strictly more than the two it replaces — `.cell-steer`'s style string
  // and a `.cell-divider` node count only ever said the shell had COMPUTED
  // something, never that anything reached the screen. Which turned out to
  // matter: this suite had never rendered a split-screen frame in its life (see
  // LobbyDemo.stop), and neither of the old assertions could tell.
  //
  // Both halves are DIFFERENCE tests, taken against the same frame with the two
  // elements suppressed through their own shipped flags (cellCards hides a bar
  // the way a FINISHED card does; dividers is the ?dividers=0 toggle). That is
  // what keeps them honest at this suite's 0.25 DPR, where the bar is ~9 device
  // pixels tall and the ink rule is one: a fixed colour threshold would be
  // measuring the antialiasing and a fixed pixel budget would be measuring
  // SwiftShader.
  //
  // It used to catch the CSS→device conversion (a missing ttp_display_ui_scale
  // moved the bar out of the sampled box). That unit is gone, so what it pins
  // now is that the bar measures against the band-fitted rect cellRectTopLeft
  // returns: sizing or centring off the raw surface grid puts it outside the box
  // below on exactly the stacked pair this test runs.
  //
  // The wait is for the RENDERER: launchRace kicks the scene rebuild off without
  // awaiting it, so under software GL the build can outlive the countdown, and
  // until it lands there is no roster to match the cells against and no cell
  // overlay to find. The DOM half above needs no such wait, because
  // ttp_display_cell_rects answers from the surface and the cell list alone.
  await page.waitForFunction(() => !window.__scene._rebuilding);
  const paint = await page.evaluate(() => {
    const s = window.__scene;
    const k = s._dpr, W = s._canvas.width, H = s._canvas.height;
    const packed = s.display.cellRects(8);
    const cells = [];
    for (let i = 0; i + 3 < packed.length; i += 4) {
      cells.push({ x: packed[i], y: packed[i + 1], w: packed[i + 2], h: packed[i + 3] });
    }
    // drawOverlay's own geometry: the authored 270 x 34 shape sitting 20 clear
    // of the bottom edge, scaled by the geometric mean of the CELL's height and
    // the SCREEN's — a damped share of the screen height, not the cell's raw
    // pixels. Both heights matter: dropping the screen term would make the bar
    // resolution-dependent, dropping the cell term would ignore the split.
    const boxes = cells.map((c) => {
      const u = 1.7 * Math.sqrt(c.h * H) / 1080;   // BAR_SCALE, per cell
      const barW = 270 * u, barH = 34 * u;
      return { x: c.x + (c.w - barW) / 2, y: c.y + c.h - 20 * u - barH,
               w: barW, h: barH };
    });
    const grab = () => s.snapshot().getContext('2d').getImageData(0, 0, W, H).data;
    const on = grab();
    s.display.cellCards(0xff); s.display.dividers(false); s.display.frame(0);
    const off = grab();
    s.display.cellCards(s._cardMask); s.display.dividers(true); s.display.frame(0);
    const changed = (x, y) => {
      const i = (y * W + x) * 4;
      return on[i] !== off[i] || on[i + 1] !== off[i + 1] || on[i + 2] !== off[i + 2];
    };
    const boxFrac = (b) => {
      const x0 = Math.round(b.x), y0 = Math.round(b.y);
      const w = Math.round(b.w), h = Math.round(b.h);
      let n = 0;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (changed(x, y)) n++;
      return n / (w * h);
    };
    // Every scanline's changed fraction. Only the ink rule spans the whole
    // width; a bar covers barW/W of a line, which is 0.17 here.
    const rows = [];
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++) if (changed(x, y)) n++;
      rows.push(n / W);
    }
    return {
      barsChanged: boxes.map(boxFrac),
      // A band the bar must NOT reach into: the same box two bar heights up, so
      // a full bar height of clearance sits between them. Any less and at 0.25
      // DPR this measures the quad's antialiased edge rather than the bar.
      abovesChanged: boxes.map((b) => boxFrac({ ...b, y: b.y - b.h * 2 })),
      // The rule is CENTRED on the seam and 4/1080 of the surface thick, which
      // at this DPR is ONE device row landing on one side of the boundary or the
      // other — so ask
      // which rows near the seam carry it, not which exact one.
      seamY: cells[1].y,
      seamRows: [-2, -1, 0, 1, 2].map((d) => rows[Math.round(cells[1].y) + d]),
      wideRows: rows.map((f, y) => [y, f]).filter(([, f]) => f > 0.5).map(([y]) => y),
      boxes: boxes.map((b) => [b.x / k, b.y / k, b.w / k, b.h / k]),
      cssCells: cells.map((c) => [c.x / k, c.y / k, c.w / k, c.h / k]),
      cssH: H / k,   // the bar's scale reads the SCREEN's height as well as its cell's
    };
  });
  // A bar in every cell, covering most of the box its own cell fraction puts it in…
  expect(paint.barsChanged).toHaveLength(2);
  for (const frac of paint.barsChanged) expect(frac).toBeGreaterThan(0.5);
  // …and nothing clear of it, which is where a bar sized or centred off the raw
  // surface grid instead of the band-fitted cell would sit.
  for (const frac of paint.abovesChanged) expect(frac).toBe(0);
  // The ink rule runs the full width at the one interior seam…
  expect(Math.max(...paint.seamRows)).toBeGreaterThan(0.9);
  // …and NOWHERE else on the canvas: every full-width scanline the overlay owns
  // sits within a couple of pixels of that seam. A rule per CELL rather than per
  // SEAM, or one measured in the wrong units, shows up here as an extra row.
  expect(paint.wideRows.length).toBeGreaterThan(0);
  for (const y of paint.wideRows) expect(Math.abs(y - paint.seamY)).toBeLessThanOrEqual(2);
  // The box those pixels were sampled in is the geometry drawOverlay derives:
  // centred on its cell, and sized off the geometric mean of the cell's height
  // and the screen's. The DOM bar's old 270 / 34 / 27 survive only as ratios — there
  // is no CSS pixel and no devicePixelRatio anywhere in the chain now, which is
  // why this compares the bar against its own cell rather than against a
  // constant. Per index, not sorted: both arrays are built from `cells` in cell
  // order, so a bar landing in the wrong cell should fail rather than sort away.
  for (const [i, b] of paint.boxes.entries()) {
    const c = paint.cssCells[i];
    const u = 1.7 * Math.sqrt(c[3] * paint.cssH) / 1080;
    expect(b[0] + b[2] / 2).toBeCloseTo(c[0] + c[2] / 2, 4);   // centred on the cell
    expect(b[2]).toBeCloseTo(270 * u, 4);                      // cell height AND
    expect(b[3]).toBeCloseTo(34 * u, 4);                       // screen height
    expect(b[1] + b[3]).toBeCloseTo(c[1] + c[3] - 20 * u, 4);
  }

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
