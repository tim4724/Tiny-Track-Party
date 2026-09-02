// @ts-check
// The controller is LANDSCAPE-ONLY, so height is its scarce axis — and the
// heights it actually gets are smaller than the ones anyone develops at: a
// small phone with the browser bar up leaves under 300px, where a dev window
// leaves 390+. Three things broke down there and none was visible at 390:
//
//   • the car strip's rows were a bare `1fr`, which carries an automatic
//     MIN-CONTENT floor — each row's floor being its render at the track's full
//     width. Those floors wanted more height than a landscape phone has, so
//     under a ~380px viewport the last cars were pushed out of sight into a
//     scroll nobody would guess was there.
//   • Settings seeds focus on "Got it", its LAST control, and a browser scrolls
//     a focused element into view — so on a card too short to fit, the sheet
//     opened with its own title already off the top. That one needs a viewport
//     short enough for the card to actually overflow, which is why it is a case
//     of its own rather than a third assertion on the fit tests.
//   • the cup panel's four schematics are SQUARE and take the width they are
//     given, so the detail card's height is set by the card's WIDTH — widening
//     the card pushed the panel down onto the action corner, which is out of
//     its flow and so does not push back. A width change surfacing as an
//     overlap is not something any other spec here would notice.
//
// All three are "does it FIT", which is why they are gated by measurement
// rather than by a screenshot. Chromium is enough here: unlike the WebKit spec
// beside this one, none of the defects is about how an engine resolves a size.
//
// The narrow tier's ORDER and SHAPE are pinned here too. The order is one line
// of CSS that has already been written both ways round; the shape is the rule
// that the picker looks the same on every phone, which is easy to lose one
// convenient breakpoint at a time. Both are invisible to every other test.
const { test, expect } = require('./helpers');

// A small landscape phone with browser chrome, and the same again narrower.
const SHORT = [{ width: 844, height: 300 }, { width: 667, height: 280 }];
// The floor of the whole set: a Z Fold cover screen (280x653) turned landscape
// with the browser bar up. The lobby has to FIT here — that is what the cap
// floors and the sub-270px tier in controller.css are for — but Settings is
// explicitly allowed to scroll below ~320px (its own tier says so, and the
// scrolling path has its own test), so the sheet's no-scroll claim stops at
// SHORT and everything else runs down to here.
const FLOOR = { width: 653, height: 232 };
const LOBBY = [...SHORT, FLOOR];

const boxes = (page, sel) => page.$$eval(sel, (els) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}));

for (const vp of LOBBY) {
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

  test(`short viewport ${at}: the cup panel stays off the corner`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/controller/index.html?scenario=lobby-race&color=0');
    await page.waitForSelector('.racedetail .track-map');

    // The DEEPEST painted descendant, not the card's own box: the panel and the
    // legend under it are what run on, and a card that has already overflowed
    // still reports its own bottom where the grid put it.
    const clear = await page.evaluate(() => {
      const card = document.querySelector('.racedetail');
      const btn = document.querySelector('.lobby-go .btn:not(.hidden)');
      let deepest = card.getBoundingClientRect().bottom;
      for (const el of card.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) deepest = Math.max(deepest, r.bottom);
      }
      return btn.getBoundingClientRect().top - deepest;
    });
    expect(clear).toBeGreaterThanOrEqual(0);
  });
}

for (const vp of SHORT) {
  const at = `${vp.width}x${vp.height}`;

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

  // ONE shape at every size: four rows down a single column, here as in the
  // landscape layout. This tier used to lie the strip down as a row of four and
  // the landscape one used to be a 2x2, which made the picker a thing you had
  // to re-read on a different phone.
  const boxes = await page.$$eval('#carpick .car-opt', (els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left) };
  }));
  expect(boxes).toHaveLength(4);
  expect(new Set(boxes.map((b) => b.top)).size, 'four rows, not one').toBe(4);
  expect(new Set(boxes.map((b) => b.left)).size, 'one column').toBe(1);
});

// The name chip and the corner buttons are the same controls in the same corner
// on the lobby and in the race, and a player steps straight from one to the
// other — so they must be the same SIZE, and the transition must not resize
// them. They were two sets of identical declarations for a while and drifted the
// moment a short-viewport tier touched only the race's: the chip went to 1rem
// against the lobby's 1.4rem and the buttons to 2.5rem against a 44px floor,
// which is a third smaller, on exactly the phones where the two screens are
// closest together. One rule each now (controller.css), and this is what says so.
for (const vp of LOBBY) {
  const at = `${vp.width}x${vp.height}`;
  test(`short viewport ${at}: the name chip and corner buttons are one size across the lobby and the race`, async ({ page }) => {
    await page.setViewportSize(vp);
    const read = async (scenario, nameSel, btnSel) => {
      await page.goto(`/controller/index.html?scenario=${scenario}&color=1`);
      await page.waitForSelector(nameSel);
      return page.evaluate(([n, b]) => {
        const N = document.querySelector(n), B = document.querySelector(b);
        const nb = N.getBoundingClientRect(), bb = B.getBoundingClientRect();
        return { font: getComputedStyle(N).fontSize, nameH: Math.round(nb.height),
          btnW: Math.round(bb.width), btnH: Math.round(bb.height) };
      }, [nameSel, btnSel]);
    };
    const lobby = await read('lobby-host', '.lobby-me__name', '.settings-btn');
    const race = await read('playing', '.hud-name', '.hud-btns .icon-btn');
    expect(race).toEqual(lobby);
    // …and the buttons still clear the fingertip floor the lobby gear documents.
    expect(lobby.btnW).toBeGreaterThanOrEqual(44);
  });
}

// .hud-top floats over the HUD rather than taking a row of it, so the identity
// row and the steer bar MAY meet — an accepted trade, not a promise. What is
// pinned is that it stays theoretical: the sticker is far left and the buttons
// far right while the bar is centred, so nothing a driver reads or presses is
// ever actually covered.
for (const vp of [...LOBBY, { width: 844, height: 390 }]) {
  const at = `${vp.width}x${vp.height}`;
  for (const mode of ['playing', 'playing-buttons']) {
    test(`short viewport ${at}: the floating ${mode} top bar covers nothing`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto(`/controller/index.html?scenario=${mode}&color=1`);
      await page.waitForSelector('.hud-name');
      const hits = await page.evaluate(() => {
        const over = (a, c) => a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top;
        const out = [];
        for (const el of document.querySelectorAll('.hud-name, .hud-btns .icon-btn')) {
          const a = el.getBoundingClientRect();
          for (const c of document.querySelectorAll('.drive-controls > button, .steer')) {
            if (over(a, c.getBoundingClientRect())) out.push(`${el.className} over ${c.id || c.className}`);
          }
          if (a.right > innerWidth + 1 || a.bottom > innerHeight + 1) out.push(`${el.className} off screen`);
        }
        return out;
      });
      expect(hits).toEqual([]);
    });
  }
}
