// @ts-check
// The display mute: ONE state with two flippers — the TV's corner button and
// the host phone's Sound row — kept in step through the snapshot's
// soundOn. This is the only automated cover for the JS glue on both ends (the
// display's set-sound verdict case, the settings card's Sound row): the C++
// host gate itself is pinned in abi_check, the snapshot schema in wire-compat.
const { test, expect, openDisplay, joinController } = require('./helpers');

test('the host\'s Sound row and the TV\'s mute button flip one state', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // first in → host
  const bob = await joinController(browser, roomCode, 'Bob');
  await expect(page.locator('#players')).toContainText('Bob');

  // A fresh profile boots un-muted, button visible on the lobby (it ships
  // hidden for the welcome board and is revealed from the lobby on).
  await expect(page.locator('#mute-btn')).toBeVisible();
  await expect(page.locator('#mute-btn')).toHaveAttribute('aria-pressed', 'false');

  // Non-host: the TV group shows the live state but is LOCKED — the display
  // would refuse the message anyway.
  await bob.click('#settings-btn');
  await expect(bob.locator('#settings-card')).toBeVisible();
  await expect(bob.locator('#tv-seg')).toHaveClass(/is-locked/);
  await expect(bob.locator('#sound-on')).toBeDisabled();
  await expect(bob.locator('#sound-off')).toBeDisabled();
  await expect(bob.locator('#sound-on')).toHaveAttribute('aria-checked', 'true');
  await bob.click('#settings-done');

  // Host: the TV group is unlocked, its Sound row showing the live state (on).
  await alice.click('#settings-btn');
  await expect(alice.locator('#tv-seg')).not.toHaveClass(/is-locked/);
  await expect(alice.locator('#sound-off')).toBeEnabled();
  await expect(alice.locator('#sound-on')).toHaveAttribute('aria-checked', 'true');

  // Phone → TV: picking Off mutes the display (button flips, device state
  // follows).
  await alice.click('#sound-off');
  await expect(alice.locator('#sound-off')).toHaveAttribute('aria-checked', 'true');
  await expect(alice.locator('#sound-on')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#mute-btn')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__audio.muted)).toBe(true);

  // TV → phone: the corner button unmutes; the OPEN settings card follows the
  // snapshot echo without being re-opened (refreshSettingsState).
  await page.click('#mute-btn');
  await expect(page.locator('#mute-btn')).toHaveAttribute('aria-pressed', 'false');
  await expect(alice.locator('#sound-on')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => window.__audio.muted)).toBe(false);

  // A tap on the picked choice changes nothing.
  await alice.click('#sound-on');
  await expect(alice.locator('#sound-on')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#mute-btn')).toHaveAttribute('aria-pressed', 'false');
});
