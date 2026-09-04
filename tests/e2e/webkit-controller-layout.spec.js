// @ts-check
// The one spec that runs on WEBKIT, and the reason it exists is that the rest
// of the suite cannot see this class of defect at all.
//
// Every other spec runs on Chromium (playwright.config.js declares no
// projects), and the phone's real audience is iOS Safari — where the car
// picker's render was broken outright for as long as it had shipped: the
// render is an ASPECT-RATIO BOX asked to derive its size from a box it does not
// own, and WebKit resolves that differently from Chromium. On the old hero card
// it was a percentage height inside an intrinsic grid track, and Safari sized
// the column from the title text instead, so the bars took the rest of the card
// and the car hung outside it. The card is gone; the shape is not. Every car
// tile now sizes its render from its view box's two axes at once, which is the
// same question asked a second way.
//
// The RATIO assertion below is the load-bearing one, and it is not academic on
// either engine: sizing from a height with a max-width cap does not letterbox,
// it keeps the height, takes the capped width and quietly stops being 5:4 —
// which the still inside it survives (object-fit: contain) and the turntable,
// a percentage-sized background, does not. That is a distorted spinning car on
// any tile taller than 5:4 is wide.
//
// So this gates GEOMETRY, not dressing — what the tile is, in the engine that
// got it wrong. It is deliberately DOM-only (a gallery scenario, no relay and
// no display), which is what keeps a second browser cheap. The press paint is
// here for the same reason: `:active` is the thing WebKit will not promise, so
// a Chromium run cannot tell whether the class that replaces it is wired.
const { test, expect } = require('./helpers');

test.use({ browserName: 'webkit', viewport: { width: 844, height: 390 } });

const LOBBY = '/controller/index.html?scenario=lobby-host';

async function tilesReady(page) {
  await page.waitForFunction(() => {
    const t = document.querySelectorAll('#carpick .car-opt .carthumb');
    return t.length === 4 && [...t].every((e) => e.getBoundingClientRect().width > 0);
  }, null, { timeout: 30000 });
}

// BOTH viewports, because they are different failures. At 844x390 a tile is
// wider than its render is tall and the HEIGHT decides; at 932x430 the tiles
// grow taller than 5:4 is wide and the WIDTH does — which is the axis a
// max-width cap silently wins, taking the ratio with it. One viewport can only
// ever see one of the two.
for (const vp of [{ width: 844, height: 390 }, { width: 932, height: 430 }]) {
test(`webkit ${vp.width}x${vp.height}: every car render sits INSIDE its tile at its own ratio`, async ({ page }) => {
  await page.setViewportSize(vp);
  await page.goto(LOBBY);
  await tilesReady(page);

  const tiles = await page.$$eval('#carpick .car-opt', (els) => els.map((e) => {
    const r = (n) => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
    return {
      tile: r(e),
      view: r(e.querySelector('.car-opt__view')),
      thumb: r(e.querySelector('.carthumb')),
      stats: r(e.querySelector('.car-opt__stats')),
      name: r(e.querySelector('.car-opt__name'))
    };
  }));
  expect(tiles).toHaveLength(4);

  for (const t of tiles) {
    // The whole failure in one assertion: the render escaping its own tile
    // because the box it is sized from collapsed behind it.
    expect(t.thumb.x).toBeGreaterThanOrEqual(t.tile.x - 1);
    expect(t.thumb.right).toBeLessThanOrEqual(t.tile.right + 1);
    expect(t.thumb.bottom).toBeLessThanOrEqual(t.view.bottom + 1);
    // At the tile's own window ratio — the 5:4 frame less the baked dead space
    // the tile crops from under the wheels (.car-opt .carthumb) — and it must
    // never merely be CLOSE: a box that has been capped on one axis keeps the
    // other, so the ratio is where the capping shows. A collapsed box shows up as
    // both this and the floor below.
    expect(t.thumb.w / t.thumb.h).toBeCloseTo(125 / 92, 2);
    // …and it fits its box on BOTH axes, which is what "letterboxed" means and
    // what the ratio alone cannot say. The HEIGHT is held to a sub-pixel: the
    // box is capped at exactly the render's own height (.car-opt__view
    // max-height), so these two are equal by construction, and a slack pixel
    // here is what let a hand-worked reciprocal (137.36 for 125/92, a percent
    // too tall) push the render past its box on the short tiers unnoticed.
    expect(t.thumb.w).toBeLessThanOrEqual(t.view.w + 1);
    expect(t.thumb.h).toBeLessThanOrEqual(t.view.h + 0.5);
    // Not a sliver. The model is what a car tile is FOR, so it gets the height
    // the name and the bars leave — Safari once gave the render 50px of 410.
    expect(t.thumb.h).toBeGreaterThan(t.tile.h * 0.3);
    // …and the ratings keep their own width, which is the tile's.
    expect(t.stats.w).toBeGreaterThan(t.tile.w * 0.7);
    // The tile reads top to bottom: render, name, ratings — and the render sits
    // on its box's FLOOR, which is what keeps the gap before the name from
    // growing by whatever height the tile happens to have spare.
    expect(t.thumb.bottom).toBeCloseTo(t.view.bottom, 0);
    expect(t.view.bottom).toBeLessThanOrEqual(t.name.y + 1);
    expect(t.name.bottom).toBeLessThanOrEqual(t.stats.y + 1);
  }
  // One shape for all four: the grid's tracks are equal, so any tile measuring
  // itself from its OWN contents (a longer name, a taller render) shows here.
  const spread = (f) => Math.max(...tiles.map(f)) - Math.min(...tiles.map(f));
  expect(spread((t) => t.thumb.h)).toBeLessThanOrEqual(1);
  expect(spread((t) => t.stats.y)).toBeLessThanOrEqual(1);
});
}

test('webkit: picking a car moves nothing but the render and the lit pips', async ({ page }) => {
  await page.goto(LOBBY);
  await tilesReady(page);

  // offsetLeft/Top/Width/Height, not getBoundingClientRect: the tile IS the
  // pressed element here, and its press is a transform (.car-opt:active). A
  // client rect includes that, so the 40ms sample below would read every tap's
  // own animation as a re-layout. The offset box is what the tile was GIVEN,
  // which is the only thing a pick may not change.
  const layout = () => page.$$eval('#carpick .car-opt', (els) => els.map((e) => {
    const r = (n) => [n.offsetLeft, n.offsetTop, n.offsetWidth, n.offsetHeight];
    return [r(e), r(e.querySelector('.car-opt__view')), r(e.querySelector('.car-opt__stats'))];
  }));
  const before = await layout();

  // Every other car, and the way back. A tile whose box is re-measured from its
  // own contents re-lays out on each of these — which is what the flicker was:
  // the ratings and the render jumping on every pick, and again when the
  // outgoing render's layer retired.
  for (const i of [3, 1, 2, 0]) {
    await page.locator('#carpick .car-opt').nth(i).click();
    // mid-swap (the cross-fade is 140ms) and settled: both have to hold, since
    // the retiring layer was itself a contributor to the old measurement.
    for (const wait of [40, 300]) {
      await page.waitForTimeout(wait);
      expect(await layout()).toEqual(before);
    }
  }
});

test('webkit: a finger down paints the button pressed, and lifting it unpaints', async ({ page }) => {
  await page.goto(LOBBY);
  await tilesReady(page);

  // Chromium's :active would answer this on its own; WebKit's will not, which
  // is why the paint is a class driven by pointer events (controller/press.js).
  // The transform is read as well as the class: a class nothing styles is the
  // way this passes while the button still looks dead.
  const btn = page.locator('#ready-btn');
  const b = await btn.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect(btn).toHaveClass(/\bheld\b/);
  expect(await btn.evaluate((e) => getComputedStyle(e).transform)).not.toBe('none');
  await page.mouse.up();
  await expect(btn).not.toHaveClass(/\bheld\b/);

  // The `:not(:disabled)` half of press.js's selector. A locked strip tile is
  // the disabled control this page actually has (the strip locks once you are
  // ready), and its own CSS takes the pointer away from it — so the pointer is
  // handed back for the length of the check, and the press must still not paint.
  await page.locator('#carpick .car-opt').first().evaluate((e) => { e.disabled = true; e.style.pointerEvents = 'auto'; });
  const tile = page.locator('#carpick .car-opt').first();
  const t = await tile.boundingBox();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await page.mouse.down();
  await expect(tile).not.toHaveClass(/\bheld\b/);
  await page.mouse.up();
});

// press.js's ONE real branch, and the collision its header exists to prevent.
// The drive controls own their `.held` in driveSurface.js because theirs is
// INPUT state, not paint: a brake released by pointerleave has to un-paint with
// the release. If press.js ever tracked them too, its release-the-previous step
// would strip a genuinely held BRAKE the moment a second finger landed
// anywhere else — the button still braking, no longer looking like it.
test('webkit: the drive controls keep their own held state, whatever else is pressed', async ({ page }) => {
  await page.goto('/controller/index.html?scenario=playing');
  await page.waitForSelector('#brake-btn');

  const brake = page.locator('#brake-btn');
  // Synthetic pointers, because a real second press cannot be held down beside
  // the first through the mouse and this is precisely a two-pointer question.
  const down = (sel) => page.locator(sel).evaluate((e) =>
    e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })));

  await down('#brake-btn');
  await expect(brake).toHaveClass(/\bheld\b/);   // driveSurface painted it

  await down('#pause-btn');                       // a chrome button press.js DOES track
  await expect(brake).toHaveClass(/\bheld\b/);   // …and BRAKE is still held
});
