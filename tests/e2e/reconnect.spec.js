// @ts-check
// Reconnect flows: a reloaded phone reclaims its seat mid-race (same clientId
// → same relay slot → WELCOME with inRace), and a CRASHED display rejoins its
// OWN room (sessionStorage) and regathers the party instead of orphaning it.
// (A clean display reload/exit tears the party down instead — pagehide sends
// close_room; see close-room.spec.js.)
const { test, expect, openDisplay, joinController, startRace, waitForRacing, visible } = require('./helpers');

test('a reloaded phone rejoins straight into its still-running race', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice'); // host
  const bob = await joinController(browser, roomCode, 'Bob');
  await startRace(alice, [bob]);
  await waitForRacing(page);

  // Bob's phone dies mid-corner. His car keeps running on the display.
  await bob.reload();
  await bob.fill('#name-input', 'Bob');
  await bob.click('#join-btn');
  // Stored clientId reclaims the same seat; WELCOME(inRace) drops him straight
  // back onto the drive screen — not the lobby, not a dead wheel.
  await bob.waitForSelector(visible('#game'), { timeout: 15000 });
});

test('a mid-race peer_left holds the seat, the car and its cell (QR up)', async ({ page, browser }) => {
  // The liveness test below covers SILENCE (socket open, no peer_left). This is
  // the other arm of session.cc's presence_action fork — a REAL socket close —
  // and no other spec drives it: mid-game the seat and the still-racing car must
  // survive the drop, so the camera stays on the cell and its reconnect QR.
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // host, peerIndex 1
  const bob = await joinController(browser, roomCode, 'Bob');     // peerIndex 2
  await startRace(alice, [bob]);
  await waitForRacing(page);

  // Bob's phone goes away for real: context close → socket close → peer_left.
  await bob.context().close();
  await page.waitForFunction(() => window.__net.flow.isDisconnected(2), null, { timeout: 10000 });

  const after = await page.evaluate(() => ({
    has: window.__net.flow.has(2),
    cars: window.__session().carIds(),
  }));
  expect(after.has).toBe(true);        // seat kept for the whole race
  expect(after.cars).toContain(2);     // car still racing — the split cell stays
  await expect(page.locator('.cell-reconnect')).toBeVisible();
});

test('a lobby peer_left frees the seat outright', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  await joinController(browser, roomCode, 'Alice'); // host, peerIndex 1
  const bob = await joinController(browser, roomCode, 'Bob'); // peerIndex 2
  await expect(page.locator('#players')).toContainText('Bob');

  await bob.context().close();
  // A drop would KEEP the seat (flow.has stays true), so this wait is the fork.
  await page.waitForFunction(() => !window.__net.flow.has(2), null, { timeout: 10000 });
  await expect(page.locator('#players')).not.toContainText('Bob');
});

test('a silent phone is dropped by liveness and restored when its pings resume', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // host, peerIndex 1
  await startRace(alice, []);
  await waitForRacing(page);

  // Lock-screen simulation: every outbound path goes quiet — pings, the CONTROL
  // stream (which falls back to the relay without a fastlane), RTC signalling —
  // but the relay socket stays OPEN, so peer_left never fires and only the
  // display's 1 Hz liveness check can notice.
  await alice.evaluate(() => {
    const net = window.__net;
    net._stopPing();
    if (net.fastlane) { net.fastlane.closeAll(); net.fastlane = null; }
    net.party._send = () => {}; // shadow the prototype method; deleted on "wake"
  });

  // ~3 s of relay silence → seat dropped, its reconnect QR card up on the cell.
  await page.waitForFunction(() => window.__net.flow.isDisconnected(1), null, { timeout: 10000 });
  await expect(page.locator('.cell-reconnect')).toBeVisible();

  // The phone wakes: traffic resumes on the SAME socket (no rejoin handshake) —
  // the seat flips back to connected and the QR card comes down.
  await alice.evaluate(() => {
    delete window.__net.party._send; // un-shadow → prototype send works again
    window.__net._startPing();
  });
  await page.waitForFunction(() => !window.__net.flow.isDisconnected(1), null, { timeout: 10000 });
  await expect(page.locator('.cell-reconnect')).toHaveCount(0);
});

test('a crashed display rejoins its own room and regathers the party', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice');
  await expect(page.locator('#players')).toContainText('Alice');

  // Crash simulation: a killed tab / bfcache freeze never runs the pagehide
  // teardown, so the room outlives the page and sessionStorage rejoins it.
  await page.evaluate(() => { window.__net.shutdown = () => {}; });
  await page.reload();
  await page.waitForFunction(() => window.__net && window.__net.roomCode, null, { timeout: 20000 });

  // Same room — the QR/link everyone scanned stays valid.
  expect(await page.evaluate(() => window.__net.roomCode)).toBe(roomCode);
  // The phone re-introduces itself (re-HELLO on peer_joined 0), restoring its
  // name on the display's fresh roster, and lands back in the lobby.
  await expect(page.locator('#players')).toContainText('Alice', { timeout: 15000 });
  await alice.waitForSelector(visible('#lobby'));
});
