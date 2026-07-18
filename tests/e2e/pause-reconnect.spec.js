// @ts-check
// Mid-race disconnect reservation + reconnect-overlay recovery.
//
// 1) A racer who drops mid-race keeps their seat + car for the WHOLE race — no
//    give-up timer (a manual pause, a locked phone, a tab switch must never cost
//    the slot). The reserved seat is reclaimed only when the room returns to the
//    lobby; there the join QR covers coming back.
// 2) The controller clears a lingering "connection lost" overlay on the 1 Hz
//    pong, not only on WELCOME — so a phone whose recovery WELCOME was missed
//    (or whose overlay a stale socket-close re-raised after rejoining) doesn't
//    stay stranded on the reconnect screen while the link is actually healthy.
const { test, expect, openDisplay, joinController, startRace, waitForRacing, visible } = require('./helpers');

// Silence a phone the way a locked screen does: outbound traffic stops but the
// socket stays open, so only the display's liveness notices.
async function goSilent(phone) {
  await phone.evaluate(() => {
    const net = window.__net; net._stopPing();
    if (net.fastlane) { net.fastlane.closeAll(); net.fastlane = null; }
    net.party._send = () => {};
  });
}

// The running race hides its chrome after ~2.5 s of pointer idle; nudge it back
// before clicking a race button that a test gap let fade out.
async function wakeChrome(page) { await page.mouse.move(400, 300); }

test('a mid-race drop reserves the seat for the whole race, then frees it in the lobby', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // host, peer 1
  const bob = await joinController(browser, roomCode, 'Bob');     // peer 2
  await startRace(alice, [bob]);
  await waitForRacing(page);

  // Bob drops mid-race — with no give-up timer the seat + car stay reserved.
  await goSilent(bob);
  await page.waitForFunction(() => window.__net.flow.isDisconnected(2), null, { timeout: 10000 });
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => window.__net.flow.has(2))).toBe(true);
  expect(await page.evaluate(() => window.__session().hasCar(2))).toBe(true);

  // Bob's phone wakes → straight back into the same race.
  await bob.evaluate(() => { delete window.__net.party._send; window.__net._startPing(); });
  await page.waitForFunction(() => !window.__net.flow.isDisconnected(2), null, { timeout: 10000 });
  await bob.waitForSelector(visible('#game'), { timeout: 10000 });

  // Drop again, then quit to the lobby: the reserved seat is reclaimed there.
  await goSilent(bob);
  await page.waitForFunction(() => window.__net.flow.isDisconnected(2), null, { timeout: 10000 });
  await wakeChrome(page);
  await page.click('#pause-btn');
  await page.click('#pause-newgame'); // returnToLobby
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
  expect(await page.evaluate(() => window.__net.flow.has(2))).toBe(false);
  await expect(page.locator('.cell-reconnect')).toHaveCount(0);
});
