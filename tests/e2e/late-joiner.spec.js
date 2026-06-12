// @ts-check
// Late joiner flow: a phone that scans the QR mid-race waits in the lobby
// (car picker live, no ready button, "race in progress" note) instead of
// landing on a dead steering wheel — and is seated in the next race.
const { test, expect, openDisplay, joinController, startRace, visible } = require('./helpers');

test('mid-race joiner waits in the lobby, then races the next one', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice'); // host
  const bob = await joinController(browser, roomCode, 'Bob');
  await startRace(alice, [bob]);
  await page.waitForFunction(() => window.__session() && window.__session().racing, null, { timeout: 20000 });
  const carsBefore = await page.evaluate(() => window.__session().engine.cars.size);

  // Carol joins mid-race: the waiting lobby, not the drive screen.
  const carol = await joinController(browser, roomCode, 'Carol');
  await carol.waitForSelector(visible('#lobby'));
  await expect(carol.locator('#ready-note')).toContainText('in the next race');
  await expect(carol.locator('#ready-btn')).toBeHidden();
  await expect(carol.locator('#game')).toBeHidden();
  // No car was spawned for her on the display — the field is what it was.
  expect(await page.evaluate(() => window.__session().engine.cars.size)).toBe(carsBefore);

  // Host aborts to the lobby — Carol's waiting note gives way to the ready button.
  await alice.click('#pause-btn');
  await alice.click('#pause-newgame');
  await carol.waitForSelector(visible('#ready-btn'));

  // The next race seats her for real.
  await startRace(alice, [bob, carol]);
  await carol.waitForSelector(visible('#game'));
});

test('an abandoned race returns to the lobby for waiting late joiners', async ({ page, browser }) => {
  // Shorten the abandoned-race grace so the test doesn't sit out the real 15 s.
  await page.addInitScript(() => { window.__abandonGraceMs = 1500; });
  const roomCode = await openDisplay(page);

  const alice = await joinController(browser, roomCode, 'Alice'); // host
  await startRace(alice, []);
  await page.waitForFunction(() => window.__session() && window.__session().racing, null, { timeout: 20000 });

  // Bob scans in mid-race and waits in his lobby for the next one.
  const bob = await joinController(browser, roomCode, 'Bob');
  await bob.waitForSelector(visible('#lobby'));

  // The only racer vanishes. Normally her seat (and the frozen race) would hold
  // its reconnect QR for the full 90 s grace — but with Bob waiting, the
  // abandoned-race timer returns the room to the lobby after a short window.
  await alice.context().close();
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 15000 });
  // Bob's waiting note gives way to the ready button — he's in the next race.
  await bob.waitForSelector(visible('#ready-btn'));
});
