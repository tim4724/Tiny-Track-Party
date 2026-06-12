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
