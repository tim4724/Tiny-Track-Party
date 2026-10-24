// @ts-check
// The phone's pause menu (pauseMenu.js). In a race the pause button holds the
// close button's corner, and the way out is the menu's "Leave game". The phone
// that asked for the pause gets its choices at once; every other phone, and
// all of them on a TV pause, waits a beat so a thumb mid-press can't land on
// one. New game is the host's, refused by the display from anyone else, and a
// host who leaves hands it on with the race still paused.
const { test, expect, openDisplay, joinController, startRace, waitForRacing, visible } = require('./helpers');

test('pause arms the other phones, New game is the host\'s, and leaving keeps the race paused', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // host
  const bob = await joinController(browser, roomCode, 'Bob');
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await expect(alice.locator('#lobby-close')).toBeVisible();
  await startRace(alice, [bob]);
  await waitForRacing(page);
  await expect(alice.locator('#close-btn')).toBeHidden();
  await expect(alice.locator('#lobby-close')).toBeHidden();

  // Bob asked for the pause: his choices are up at once, Alice's wait a beat.
  await bob.click('#pause-btn');
  await alice.waitForSelector(visible('#pause-overlay'));
  await expect(bob.locator('#pause-overlay')).not.toHaveClass(/pause--arming/);
  await expect(alice.locator('#pause-overlay')).toHaveClass(/pause--arming/);
  await expect(alice.locator('#pause-continue')).toBeHidden();
  await expect(alice.locator('#pause-continue')).toBeVisible();

  await expect(alice.locator('#pause-newgame')).toBeVisible();
  await expect(bob.locator('#pause-newgame')).toBeHidden();
  await expect(bob.locator('#pause-leave')).toBeVisible();
  // However a guest sends it, the display refuses New game.
  await bob.evaluate(() => window.__net.send(window.MSG.RETURN_TO_LOBBY));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__net.roomState)).toBe('playing');

  await bob.click('#pause-continue');
  await expect(page.locator('#pause-overlay')).toBeHidden();
  await expect(alice.locator('#pause-overlay')).toBeHidden();

  // A TV pause (back on the display) arms every phone.
  await page.goBack();
  await alice.waitForSelector(visible('#pause-overlay'));
  await bob.waitForSelector(visible('#pause-overlay'));
  await expect(alice.locator('#pause-overlay')).toHaveClass(/pause--arming/);
  await expect(bob.locator('#pause-overlay')).toHaveClass(/pause--arming/);

  // The host leaves: the race stays paused and Bob is promoted, menu and all.
  await alice.click('#pause-leave');
  await alice.waitForSelector(visible('#name'));
  await expect(bob.locator('#pause-newgame')).toBeVisible();
  await expect(bob.locator('#pause-newgame')).toHaveText('New game');
  expect(await page.evaluate(() => window.__net.roomState)).toBe('playing');
  await expect(page.locator('#pause-overlay')).toBeVisible();

  await bob.click('#pause-newgame');
  await bob.click('#leavecup-confirm');
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
  await expect(bob.locator(visible('#lobby'))).toBeVisible();
});
