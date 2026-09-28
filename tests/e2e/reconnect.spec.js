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

test('a mid-race drop holds the seat, the car and its cell — the lobby return frees it',
  async ({ page, browser }) => {
    // The spec below covers SILENCE, which drops nobody. This is the MID-GAME arm
    // of session.cc's presence_action fork on a real socket close, and no other
    // spec drives it: the seat and the still-racing car must survive the drop, so
    // the camera stays on the cell and its reconnect QR.
    //
    // There is no give-up timer: a manual pause, a locked phone or a tab switch
    // must never cost the slot. Which makes the RELEASE half a rule of its own —
    // the reservation ends at the lobby, where the join QR covers coming back —
    // and it is asserted here rather than in its own full-race spec.
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

    // Quit to the lobby from a controller (robust vs the display's auto-hiding
    // race chrome): the reserved seat is reclaimed there, its card gone with it.
    await alice.evaluate(() => window.__net.send(window.MSG.RETURN_TO_LOBBY));
    await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 15000 });
    expect(await page.evaluate(() => window.__net.flow.has(2))).toBe(false);
    await expect(page.locator('.cell-reconnect')).toHaveCount(0);
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

test('a silent phone keeps its seat: only the socket closing drops one', async ({ page, browser }) => {
  // THE RULE, end to end: presence is the relay's answer, from peer_joined to
  // peer_left. A player who simply stops steering — parked on the grid, phone
  // face-down on the sofa, hands off the wheel — sends nothing at all, and the
  // big screen must not read that as leaving. This spec asserted the OPPOSITE
  // while the display ran a silence window of its own; native/libttp-party's
  // CLAUDE.md carries why that was given up.
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // host, peerIndex 1
  await startRace(alice, []);
  await waitForRacing(page);

  // Lock-screen simulation: every outbound path goes quiet — pings, the CONTROL
  // stream (which falls back to the relay without a fastlane), RTC signalling —
  // but the relay socket stays OPEN, so peer_left never fires.
  await alice.evaluate(() => {
    const net = window.__net;
    net._stopPing();
    if (net.fastlane) { net.fastlane.closeAll(); net.fastlane = null; }
    net.party._send = () => {}; // shadow the prototype method; deleted on "wake"
  });

  // Well past the window that used to drop it, and past three of the display's
  // own ticks. Nothing happens: seat connected, car racing, no QR card.
  await page.waitForTimeout(5000);
  expect(await page.evaluate(() => ({
    disc: window.__net.flow.isDisconnected(1),
    cars: window.__session().carIds(),
  }))).toEqual({ disc: false, cars: expect.arrayContaining([1]) });
  await expect(page.locator('.cell-reconnect')).toHaveCount(0);

  // Traffic resuming on the SAME socket is a non-event too — nothing to restore.
  await alice.evaluate(() => {
    delete window.__net.party._send; // un-shadow → prototype send works again
    window.__net._startPing();
  });
  await expect(page.locator('.cell-reconnect')).toHaveCount(0);

  // Its socket closing IS the event, and mid-race that is the soft drop: seat
  // and car kept, reconnect QR up.
  await alice.context().close();
  await page.waitForFunction(() => window.__net.flow.isDisconnected(1), null, { timeout: 10000 });
  await expect(page.locator('.cell-reconnect')).toBeVisible();
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
