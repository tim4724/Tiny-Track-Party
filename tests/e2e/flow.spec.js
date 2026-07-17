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

  await startRace(alice, [bob]);

  // Display flips to the race, phones get the drive HUD, countdown reaches GO.
  await page.waitForSelector(visible('#race'));
  await alice.waitForSelector(visible('#game'));
  await bob.waitForSelector(visible('#game'));
  await waitForRacing(page);

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
