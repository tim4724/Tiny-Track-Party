// @ts-check
// The one spec that runs on WEBKIT, and the reason it exists is that the rest
// of the suite cannot see this class of defect at all.
//
// Every other spec runs on Chromium (playwright.config.js declares no
// projects), and the phone's real audience is iOS Safari — where the car card
// was broken outright for as long as it has shipped: the render's column was an
// `auto` grid track left to derive its own width from a height:100% thumb, and
// WebKit does not resolve an aspect-ratio box's width from a percentage height
// when it measures an intrinsic track. Safari sized that column from the title
// text instead, so the bars took the rest of the card and the car hung outside
// it, and every pick re-measured and moved them again.
//
// So this gates GEOMETRY, not dressing — what the card is, in the engine that
// got it wrong. It is deliberately DOM-only (a gallery scenario, no relay and
// no display), which is what keeps a second browser cheap. The press paint is
// here for the same reason: `:active` is the thing WebKit will not promise, so
// a Chromium run cannot tell whether the class that replaces it is wired.
const { test, expect } = require('./helpers');

test.use({ browserName: 'webkit', viewport: { width: 844, height: 390 } });

const LOBBY = '/controller/index.html?scenario=lobby-host';

const box = (page, sel) => page.locator(sel).evaluate((e) => {
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
});

async function cardReady(page) {
  await page.waitForFunction(() => {
    const t = document.querySelector('.car-hero__view .carthumb');
    return !!t && t.getBoundingClientRect().width > 0;
  }, null, { timeout: 30000 });
}

test('webkit: the hero render sits INSIDE its card, sized from the row it shares with the bars', async ({ page }) => {
  await page.goto(LOBBY);
  await cardReady(page);

  const hero = await box(page, '#car-hero');
  const view = await box(page, '.car-hero__view');
  const thumb = await box(page, '.car-hero__view .carthumb');
  const stats = await box(page, '.car-opt__stats');

  // The whole failure in one assertion: the render escaped the card to the LEFT,
  // over the tap strip, because its column had collapsed behind it.
  expect(thumb.x).toBeGreaterThanOrEqual(hero.x);
  expect(thumb.right).toBeLessThanOrEqual(hero.right + 1);
  expect(stats.right).toBeLessThanOrEqual(hero.right + 1);

  // The render fills its column at the thumbnail's own 5:4 — the ratio is what
  // decides the column's width, so a column sized from anything else shows up
  // here as a thumb that no longer matches it.
  expect(thumb.w).toBeCloseTo(view.w, 0);
  expect(thumb.w / thumb.h).toBeCloseTo(5 / 4, 2);

  // Neither half is a sliver: the bars exist to be compared, and the car is the
  // one thing the card is for. Safari gave the render 50px of 410.
  expect(view.w).toBeGreaterThan(hero.w * 0.3);
  expect(stats.w).toBeGreaterThan(hero.w * 0.3);
});

test('webkit: picking a car moves nothing but the render and the bar fills', async ({ page }) => {
  await page.goto(LOBBY);
  await cardReady(page);

  const layout = async () => ({
    hero: await box(page, '#car-hero'),
    view: await box(page, '.car-hero__view'),
    stats: await box(page, '.car-opt__stats')
  });
  const before = await layout();

  // Every other car, and the way back. A card whose columns are re-measured from
  // its own contents re-lays out on each of these — which is what the flicker
  // was: the bars and the render jumping on every pick, and again when the
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
  await cardReady(page);

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
