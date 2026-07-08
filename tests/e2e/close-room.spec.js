// @ts-check
// Room teardown (close_room / close code 4001): the display asks the relay to
// end the party for everyone. Every phone's socket closes with 4001, which
// PartyConnection surfaces as onClose {roomClosed} — a TERMINAL state (no
// auto-reconnect: the room is deleted, a retry would only bounce off "Room not
// found"), so the phone shows its party-over screen. The display's own 4001
// self-heals: it forgets the dead room and opens a fresh one with a new code.
const { test, expect, openDisplay, joinController, visible } = require('./helpers');

test('closing the room bails every phone terminally and re-opens the display on a fresh room', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice');
  const bob = await joinController(browser, roomCode, 'Bob');
  await expect(page.locator('#players')).toContainText('Bob');

  // The host ends the party (nothing in the UI fires this today — the trigger
  // is the API itself; see DisplayNet.closeRoom for why pagehide must not).
  await page.evaluate(() => window.__net.closeRoom());

  // Both phones land on the terminal party-over overlay: no retry button (the
  // room is gone for good), only the exit escape hatch.
  for (const phone of [alice, bob]) {
    await phone.waitForSelector(visible('#conn'), { timeout: 15000 });
    await expect(phone.locator('#conn-title')).toHaveText('Race over');
    await expect(phone.locator('#conn-retry')).toBeHidden();
    await expect(phone.locator('#conn-leave')).toBeVisible();
  }

  // The display self-heals into a FRESH room: new code, joinable again.
  await page.waitForFunction(
    (old) => window.__net.roomCode && window.__net.roomCode !== old,
    roomCode, { timeout: 15000 }
  );
  const newCode = await page.evaluate(() => window.__net.roomCode);
  const carol = await joinController(browser, newCode, 'Carol');
  await expect(page.locator('#players')).toContainText('Carol');
  await carol.waitForSelector(visible('#lobby'));
});
