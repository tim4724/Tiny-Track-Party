// @ts-check
// Device chooser: the display URL on a phone-sized viewport offers the
// big-screen/join fork and defers room creation until a choice is made;
// big screens never see it.
const { test, expect, relayQuery, openDisplay } = require('./helpers');

test('phone-sized visit gets the chooser and defers the room', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`/?${relayQuery}`);

  await page.waitForSelector('#device-choice', { state: 'visible' });
  // No ghost room while the chooser is up. Asserting a NON-event is inherently
  // time-based (a poll-until-pass would succeed on the first null and prove
  // nothing), so give a wrongly-started boot a grace window, then check that
  // net.start() never even opened a connection — not just that no room exists.
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => ({ connected: !!window.__net.party, room: window.__net.roomCode })))
    .toEqual({ connected: false, room: null });

  // Committing to the big screen creates the room and dismisses the chooser.
  await page.click('#device-continue');
  await page.waitForFunction(() => window.__net.roomCode, null, { timeout: 20000 });
  await page.waitForSelector('#device-choice', { state: 'hidden' });
});

test('big screens never see the chooser', async ({ page }) => {
  await openDisplay(page); // room created straight away at 1280x720
  await expect(page.locator('#device-choice')).toBeHidden();
});
