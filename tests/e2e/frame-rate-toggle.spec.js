// @ts-check
// The host's Smooth/Sharp row: the JS glue on both ends (the display's
// set-frame-rate verdict case and its persistence, the settings card's row).
// The rule, the offer and the host gate are pinned in render_scale_check and
// abi_check.
//
// Under automation the render scale never adapts, so no display here can EARN
// the offer; a remembered Sharp choice is the one way in, and it is the real
// one — the offer always stands while half rate is on, so the host can switch
// back.
const { test, expect, openDisplay, joinController } = require('./helpers');

test('a remembered Sharp choice is offered to the host, and Smooth puts it away', async ({ page, browser }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('rate-seeded')) {
      sessionStorage.setItem('rate-seeded', '1');
      localStorage.setItem('tinytrack_half_rate', '1');
    }
  });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // first in → host
  const bob = await joinController(browser, roomCode, 'Bob');
  await expect(page.locator('#players')).toContainText('Bob');

  // Non-host: no TV section at all.
  await bob.click('#settings-btn');
  await expect(bob.locator('#rate-row')).toBeHidden();

  // Host: the row, with the remembered choice picked and the panel's own rates.
  await alice.click('#settings-btn');
  await expect(alice.locator('#rate-row')).toBeVisible();
  await expect(alice.locator('#rate-half')).toHaveAttribute('aria-checked', 'true');
  await expect(alice.locator('#rate-half-hz')).toHaveText(/^\d+ fps$/);

  // Smooth: the display forgets the choice, and — holding 60 under automation,
  // so never having earned the offer — stops offering it. The open card follows.
  await alice.click('#rate-full');
  await expect(alice.locator('#rate-row')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('tinytrack_half_rate'))).toBe('0');
});
