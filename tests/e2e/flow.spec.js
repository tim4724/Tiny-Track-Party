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
  // A tap on the locked strip answers with the unlock hint (locked tiles have
  // pointer-events off, so the tap lands on the container — see main.js).
  await bob.click('#carpick');
  await expect(bob.locator('#ready-note')).toContainText('change your car');
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
    // EIGHT floats a cell: the picture rect, then the same cell intersected with
    // the TV overscan safe zone. Both are asserted below and they check
    // different things — the picture is what must tile the surface, the safe
    // rect is what the edge-anchored chrome has to sit inside.
    const packed = s.display.cellRects(8);
    for (let i = 0; i < packed.length; i += 8) {
      cells.push({ x: packed[i], y: packed[i + 1], w: packed[i + 2], h: packed[i + 3],
                   safe: { x: packed[i + 4], y: packed[i + 5],
                           w: packed[i + 6], h: packed[i + 7] } });
    }
    const px = (el, p) => parseFloat(el.style[p]);
    return {
      canvas: { w: s._canvas.width, h: s._canvas.height },
      // What the fractions are multiplied BY, and the buffer is deliberately not
      // it: the container does not move when the render scale steps.
      container: { w: s.container.clientWidth, h: s.container.clientHeight },
      view: { w: window.innerWidth, h: window.innerHeight },
      cells,
      // The fraction the page itself declares, so this asserts the safe rect
      // against the authored token rather than against a number retyped here.
      safeFrac: {
        x: parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue('--safe-frac-x')),
        y: parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue('--safe-frac-y')),
      },
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
  // FRACTIONS OF THE SURFACE, 0..1 (ttp_display_cell_rects) — so the grid is
  // measured against 1 rather than against the buffer, and the tolerances below
  // are the old whole-pixel ones expressed in that unit.
  expect(spanX).toBeLessThanOrEqual(1 + 1e-6);
  expect(spanY).toBeLessThanOrEqual(1 + 1e-6);
  // cols-1 px at most either side of centre, cols <= 2 here
  expect(Math.abs(1 - spanX - barL)).toBeLessThan(2 / layout.canvas.w);
  expect(1 - spanY).toBeLessThan(2 / layout.canvas.h);
  // THE SAFE ZONE. Every cell is inset by the authored fraction on ALL FOUR
  // edges — the same margin against the divider as against the screen, which is
  // the whole point: insetting only the edges a television can actually crop
  // puts two different margins in one row and reads as a bug. The fraction is of
  // the SURFACE, so a stacked pair's two cells take the same ABSOLUTE margin
  // even though the grid is letterboxed and neither touches the screen's sides.
  const eps = 1e-6;
  expect(layout.safeFrac.x).toBeGreaterThan(0);
  expect(layout.safeFrac.y).toBeGreaterThan(0);
  for (const c of layout.cells) {
    expect(c.safe.x).toBeCloseTo(c.x + layout.safeFrac.x, 5);
    expect(c.safe.y).toBeCloseTo(c.y + layout.safeFrac.y, 5);
    expect(c.safe.w).toBeCloseTo(c.w - 2 * layout.safeFrac.x, 5);
    expect(c.safe.h).toBeCloseTo(c.h - 2 * layout.safeFrac.y, 5);
  }
  // Not vacuous: the stacked pair really does have one cell on the screen's top
  // edge and one on its bottom, and they are treated identically.
  expect(layout.cells.some((c) => c.y <= eps)).toBe(true);
  expect(layout.cells.some((c) => c.y + c.h >= 1 - eps)).toBe(true);

  // …and every label is at its cell's top-left corner IN CSS PIXELS, with the
  // place/lap readout on the same cell's top-RIGHT (so the width is scaled too,
  // not just the origin). Compared as a set, since DOM order is creation order
  // rather than cell order, and with Stage.js's own arithmetic (scale first,
  // then offset) so this compares the layout, not two roundings.
  // THE SAFE RECT, because that is what the chips are placed from: a name chip
  // at the picture's corner is a name chip a television can crop. The picture's
  // own geometry is asserted above, where it belongs.
  const css = layout.cells.map((c) => ({
    x: c.safe.x * layout.container.w, y: c.safe.y * layout.container.h,
    w: c.safe.w * layout.container.w, h: c.safe.h * layout.container.h,
  }));
  // Sorted by x-then-y and compared NUMERICALLY, to a tolerance far below a
  // pixel. It used to be string equality of the two computations, which was
  // exact only while every cell origin was a fraction like 0 or 0.5: the safe
  // inset makes them 0.05, and 0.05 is not representable in the float32 the ABI
  // packs, so the same product reaches this line and the DOM through two
  // different roundings of the same number. A tenth of a milli-pixel cannot be a
  // layout bug, and a quarter-cell offset — the failure this guards, an un-scaled
  // or double-scaled rect — is six orders of magnitude bigger.
  const byPoint = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
  const near = (got, want, what) => {
    expect(got).toHaveLength(want.length);
    got.slice().sort(byPoint).forEach((p, i) => {
      const q = want.slice().sort(byPoint)[i];
      expect(p[0], `${what} x`).toBeCloseTo(q[0], 3);
      expect(p[1], `${what} y`).toBeCloseTo(q[1], 3);
    });
  };
  near(layout.labels, css.map((r) => [r.x, r.y]), 'name chip');
  near(layout.ranks, css.map((r) => [r.x + r.w - 12, r.y + 11]), 'place/lap');
  // The cells fill the screen the HUD lays out on, so a label is never stranded
  // in the corner of a quarter-sized grid (the un-scaled failure). Height is
  // never capped, so it is the exact check; across the width it is the grid PLUS
  // the two letterbox bars that reaches both edges.
  expect(spanY * layout.container.h).toBeGreaterThan(layout.view.h - 4);
  expect((spanX + barL) * layout.container.w).toBeGreaterThan(layout.view.w - 4);

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
    // THE PICTURE RECT — the first four of the eight floats a cell answers with.
    // The steer bar is the renderer's and is deliberately NOT inset by the safe
    // zone (TtpRendererFrame.cpp argues why), so the safe rect would find it in
    // the wrong place by exactly the inset.
    for (let i = 0; i + 7 < packed.length; i += 8) {
      // FRACTIONS of the surface (ttp_display_cell_rects) scaled to the BUFFER,
      // which is the space this probe works in: it samples getImageData, and
      // drawOverlay's own geometry below is a share of the buffer's height.
      cells.push({ x: packed[i] * W, y: packed[i + 1] * H,
                   w: packed[i + 2] * W, h: packed[i + 3] * H });
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
