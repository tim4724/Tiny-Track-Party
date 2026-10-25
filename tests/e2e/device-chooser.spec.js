// @ts-check
// Device chooser: the display URL on a phone-sized viewport offers the
// big-screen/join fork and defers room creation until a choice is made;
// big screens never see it.
const { test, expect, openDisplay } = require('./helpers');

test('phone-sized visit gets the chooser and defers the room', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const engineFetches = [];
  page.on('request', (r) => { if (/\/engine\/native\/.*\.(wasm|filamat)$/.test(r.url())) engineFetches.push(r.url()); });
  await page.goto('/');

  await page.waitForSelector('#device-choice', { state: 'visible' });
  // The boot must take the DEFERRED path: __deviceChoicePending flips true the
  // moment whenDeviceChosen defers (deterministic — the chooser itself is
  // visible from first paint, before the module runs). The whole engine boot
  // waits behind it, so there is no net yet and not one engine byte has been
  // asked for: a phone reading the landing never pays for the 3D.
  await page.waitForFunction(() => window.__deviceChoicePending === true);
  expect(await page.evaluate(() => typeof window.__net)).toBe('undefined');
  expect(engineFetches).toEqual([]);

  // Committing to the big screen creates the room and dismisses the chooser.
  await page.click('#device-continue');
  await page.waitForFunction(() => window.__net && window.__net.roomCode, null, { timeout: 20000 });
  await page.waitForSelector('#device-choice', { state: 'hidden' });
});

test('big screens never see the chooser', async ({ page }) => {
  await openDisplay(page); // room created straight away at 1280x720
  await expect(page.locator('#device-choice')).toBeHidden();
  // Behavioural signal, not just CSS: a big-screen boot takes the immediate path,
  // it never defers behind the chooser (the inverse of the deferred-path test above).
  expect(await page.evaluate(() => window.__deviceChoicePending)).toBeFalsy();
});
