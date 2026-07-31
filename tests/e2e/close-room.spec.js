// @ts-check
// Room teardown (close_room / close code 4001): the display asks the relay to
// end the party for everyone. Every phone's socket closes with 4001, which
// PartyConnection surfaces as onClose {roomClosed} — a TERMINAL state (no
// auto-reconnect: the room is deleted, a retry would only bounce off "Room not
// found"), so the phone shows its party-over screen. Fired two ways: the API
// (a future host "End party" action — the display's own 4001 then self-heals
// into a fresh room) and the pagehide handler (the TV tab exiting ends the
// party; the reloaded page finds its saved room dead and opens a fresh one).
const { test, expect, openDisplay, joinController, visible } = require('./helpers');

// The terminal party-over overlay: no retry button (the room is gone for
// good), only the exit escape hatch.
async function expectRaceOver(phone) {
  await phone.waitForSelector(visible('#conn'), { timeout: 15000 });
  await expect(phone.locator('#conn-title')).toHaveText('Race over');
  await expect(phone.locator('#conn-retry')).toBeHidden();
  await expect(phone.locator('#conn-leave')).toBeVisible();
}

test('closing the room bails every phone terminally and re-opens the display on a fresh room', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice');
  const bob = await joinController(browser, roomCode, 'Bob');
  await expect(page.locator('#players')).toContainText('Bob');

  // The host ends the party via the API (the future "End party" action — no UI
  // fires this yet; page exits go through shutdown() and the pagehide spec below).
  await page.evaluate(() => window.__net.closeRoom());

  for (const phone of [alice, bob]) await expectRaceOver(phone);

  // The display self-heals into a FRESH room: new code, joinable again.
  await page.waitForFunction(
    // Guarded like helpers' own roomCode wait: a poll can land while the page
    // is still booting (no __net yet), and an unguarded read THROWS, which
    // fails the wait outright instead of retrying.
    (old) => window.__net && window.__net.roomCode && window.__net.roomCode !== old,
    roomCode, { timeout: 15000 }
  );
  const newCode = await page.evaluate(() => window.__net.roomCode);
  const carol = await joinController(browser, newCode, 'Carol');
  await expect(page.locator('#players')).toContainText('Carol');
  await carol.waitForSelector(visible('#lobby'));
});

test('the display tab exiting (pagehide) ends the party on every phone', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await expect(page.locator('#players')).toContainText('Alice');

  // A reload exits the page exactly like a close/navigation (pagehide →
  // net.shutdown() → close_room), with the bonus that we can watch the same
  // tab boot again afterwards.
  await page.reload();

  // The phone bails terminally — no 2-minute hostless grace, no reconnect spin.
  await expectRaceOver(alice);

  // The rebooted display finds its saved room dead ("Room not found") and falls
  // back to a FRESH one: the party is over, the next party is ready to join.
  await page.waitForFunction(
    // Guarded (see above): this one polls ACROSS the reload, so early polls
    // race the module tail that sets __net on every slow boot.
    (old) => window.__net && window.__net.roomCode && window.__net.roomCode !== old,
    roomCode, { timeout: 20000 }
  );
});
