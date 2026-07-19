// @ts-check
// A racer who drops mid-race keeps their seat + car for the WHOLE race — there is
// no give-up timer (a manual pause, a locked phone, a tab switch must never cost
// the slot). The reserved seat is reclaimed only when the room returns to the
// lobby, where the join QR covers coming back.
const { test, expect, openDisplay, joinController, startRace, waitForRacing } = require('./helpers');

// Silence a phone the way a locked screen does: outbound traffic stops but the
// socket stays open, so only the display's liveness notices (no peer_left).
async function goSilent(phone) {
  await phone.evaluate(() => {
    const net = window.__net; net._stopPing();
    if (net.fastlane) { net.fastlane.closeAll(); net.fastlane = null; }
    net.party._send = () => {};
  });
}

test('a mid-race drop reserves the seat, then frees it on lobby return', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // host, peer 1
  const bob = await joinController(browser, roomCode, 'Bob');     // peer 2
  await startRace(alice, [bob]);
  await waitForRacing(page);

  // Bob drops mid-race — with no give-up timer, the seat + car stay reserved.
  await goSilent(bob);
  await page.waitForFunction(() => window.__net.flow.isDisconnected(2), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__net.flow.has(2))).toBe(true);
  expect(await page.evaluate(() => window.__session().hasCar(2))).toBe(true);

  // Quit to the lobby via a controller (robust vs the display's auto-hiding race
  // chrome): the reserved seat is reclaimed there, its reconnect card gone.
  await alice.evaluate(() => window.__net.send(window.MSG.RETURN_TO_LOBBY));
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 15000 });
  expect(await page.evaluate(() => window.__net.flow.has(2))).toBe(false);
  await expect(page.locator('.cell-reconnect')).toHaveCount(0);
});
