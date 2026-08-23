// @ts-check
// The controller is LANDSCAPE-ONLY, so height is its scarce axis — and the
// heights it actually gets are smaller than the ones anyone develops at: a
// small phone with the browser bar up leaves under 300px, where a dev window
// leaves 390+. Two things broke down there and neither was visible at 390:
//
//   • the car strip's 2x2 rows were a bare `1fr`, which carries an automatic
//     MIN-CONTENT floor — each tile's floor being its 5:4 thumbnail at the
//     column's full width. Two of those floors wanted ~340px of a column that
//     is half a landscape screen, so under a ~380px viewport the bottom two
//     cars were pushed out of sight into a scroll nobody would guess was there.
//   • Settings seeds focus on "Got it", its LAST control, and a browser scrolls
//     a focused element into view — so on a card too short to fit, the sheet
//     opened with its own title already off the top. That one needs a viewport
//     short enough for the card to actually overflow, which is why it is a case
//     of its own rather than a third assertion on the fit tests.
//
// Both are "does it FIT", which is why they are gated by measurement rather
// than by a screenshot. Chromium is enough here: unlike the WebKit spec beside
// this one, neither defect is about how an engine resolves a size.
//
// The narrow tier's ORDER is pinned here too. It is one line of CSS that has
// already been written both ways round, and getting it wrong is invisible to
// every other test in the tree.
const { test, expect } = require('./helpers');

// A small landscape phone with browser chrome, and the same again narrower.
const SHORT = [{ width: 844, height: 300 }, { width: 667, height: 280 }];

const boxes = (page, sel) => page.$$eval(sel, (els) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}));

for (const vp of SHORT) {
  const at = `${vp.width}x${vp.height}`;

  test(`short viewport ${at}: all four cars are on screen, and the strip does not scroll`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/controller/index.html?scenario=lobby-host&color=0');
    await page.waitForSelector('#carpick .car-opt');
    await expect(page.locator('#carpick .car-opt')).toHaveCount(4);

    // The strip is a scroll container by design (it has to be when the cup list
    // is long), so "no scrollbar" is the assertion, not "no overflow property".
    const strip = await page.locator('#carpick').evaluate((e) => ({
      scrollH: e.scrollHeight, clientH: e.clientHeight,
      top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom
    }));
    expect(strip.scrollH).toBeLessThanOrEqual(strip.clientH + 1);

    // …and every tile is inside it, which is what the scroll check means in
    // the end: the fourth car is reachable without discovering a gesture.
    for (const t of await boxes(page, '#carpick .car-opt')) {
      expect(t.bottom).toBeLessThanOrEqual(strip.bottom + 1);
      expect(t.top).toBeGreaterThanOrEqual(strip.top - 1);
    }

    // The corner is the navigation; if it leaves the viewport there is no way on.
    const go = await boxes(page, '.lobby-go .btn:not(.hidden)');
    expect(go.length).toBeGreaterThan(0);
    for (const b of go) expect(b.bottom).toBeLessThanOrEqual(vp.height);
  });

  test(`short viewport ${at}: the whole Settings sheet fits`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/controller/index.html?scenario=settings&color=0');
    await page.waitForSelector('#settings-card');

    // No scroll at all at these sizes — both choices, the TV switch and the way
    // out on one screen. This is what the @media (max-height: 320px) tier buys.
    const card = page.locator('#settings-card');
    expect(await card.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(1);

    const [head] = await boxes(page, '.settings-head');
    expect(head.top).toBeGreaterThanOrEqual(0);
    const [done] = await boxes(page, '#settings-done');
    expect(done.bottom).toBeLessThanOrEqual(vp.height);
  });
}

// Below the tier the card scrolls, which is what its overflow-y has always been
// for — and scrolling is exactly the state in which the focus seed can move it,
// because "Got it" is the card's LAST control. The fit tests above cannot see
// this: at their heights the card does not overflow, so it cannot be scrolled
// and `scrollTop === 0` would hold with the fix reverted.
test('very short viewport: Settings opens at its title even once the card must scroll', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 240 });
  await page.goto('/controller/index.html?scenario=settings&color=0');
  await page.waitForSelector('#settings-card');

  const card = page.locator('#settings-card');
  // The premise. Without it the assertion below is unfalsifiable.
  expect(await card.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeGreaterThan(0);
  expect(await card.evaluate((e) => e.scrollTop)).toBe(0);

  const [head] = await boxes(page, '.settings-head');
  expect(head.top).toBeGreaterThanOrEqual(0);
});

// Narrow enough to stack (controller.css @media max-width: 620px). The page
// scrolls here, so the only thing holding the three blocks in a sensible order
// is the grid-template-areas list.
test('narrow viewport: the stack reads choices, then the pick, then the way on', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('/controller/index.html?scenario=lobby-host&color=0');
  await page.waitForSelector('#carpick .car-opt');

  const top = (sel) => page.locator(sel).evaluate((e) => e.getBoundingClientRect().top);
  const [strip, card, go] = await Promise.all([top('#carpick'), top('.car-card'), top('.lobby-go')]);

  // The same order the wide layout reads left-to-right, so stepping between the
  // two shapes is not a re-learn. It used to be sel, go, pick.
  expect(strip).toBeLessThan(card);
  expect(card).toBeLessThan(go);

  // Stacked, the strip lies down — one row of four. As a 2x2 at the full page
  // width the four tiles cost ~475px of scroll and buried the card.
  const tops = await page.$$eval('#carpick .car-opt', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});
