// @ts-check
// Grand Prix cups: a fresh host auto-picks the Beach Cup, so Start commits to
// its 4 tracks back-to-back — intermission standings between races (host can
// advance early or quit; otherwise it auto-advances), podium after race 4,
// then "New game" back to the lobby with the cup rewound to race 1. Races are
// ended by force-finishing every human car (the same recipe as the display
// TestHarness 'finished' scenario): humansAllDone then fast-forwards the AI to
// the flag and endRace fires on the next frame.
const { test, expect, openDisplay, joinController, startRace, waitForRacing, visible } = require('./helpers');

const BEACH = ['tidepool', 'cove', 'driftwood', 'riptide']; // CUPS order (race 1..4)

// Mark every human car finished with a synthetic time (the sanctioned
// forceFinish staging hook); the engine's next frame does the rest
// (fast-forward → endRace).
const finishHumans = (display) => display.evaluate(() => {
  const session = window.__session();
  let t = 20;
  for (const id of session.carIds()) {
    if (String(id).startsWith('ai-')) continue;
    session.forceFinish(id, (t += 5.3));
  }
});

const inResults = (display, timeout = 30000) =>
  display.waitForFunction(() => window.__net.roomState === 'results', null, { timeout });

test('a cup chains through all 4 races to the podium (host advancing early)', async ({ page, browser }) => {
  // Intermission effectively OFF (60 s) — every advance in this test is the host's tap.
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice'); // first in → host
  const bob = await joinController(browser, roomCode, 'Bob');

  // Fresh host storage → the Beach Cup is auto-picked (cup mode, race 1 resolved).
  await page.waitForFunction(() => window.__net.mode === 'cup' && window.__net.trackId != null, null, { timeout: 10000 });
  expect(await page.evaluate(() => ({ cup: window.__net.cupId, track: window.__net.trackId })))
    .toEqual({ cup: 'beach', track: BEACH[0] });

  await startRace(alice, [bob]);
  await waitForRacing(page);
  expect(await page.evaluate(() => window.__series() && window.__series().raceIndex)).toBe(0);

  // Races 1-3: finish → intermission board on both screens → host taps "Next race".
  for (let race = 1; race <= 3; race++) {
    await finishHumans(page);
    await inResults(page);
    await expect(page.locator('#results-sub')).toContainText(`Race ${race} of 4`);
    await expect(page.locator('#results-next')).toContainText(BEACH[race].charAt(0).toUpperCase() + BEACH[race].slice(1));
    await expect(alice.locator('#newgame-btn')).toHaveText('Next race ▸');
    await expect(alice.locator(visible('#quitcup-btn'))).toBeVisible();
    await expect(bob.locator('#result-wait')).toContainText('starting soon');
    await alice.click('#newgame-btn');
    await waitForRacing(page);
    expect(await page.evaluate(() => window.__net.trackId)).toBe(BEACH[race]);
  }

  // Race 4: finish → podium (title = cup champs sticker, top-three steps, "New game").
  await finishHumans(page);
  await inResults(page);
  await expect(page.locator('#results-title')).toHaveText('Beach Cup CHAMPS!');
  expect(await page.locator('.podium__col').count()).toBe(3);
  await expect(alice.locator('#results-title')).toContainText('Beach Cup — Final');
  await expect(alice.locator('#newgame-btn')).toHaveText('New game');
  await expect(alice.locator('#quitcup-btn')).toBeHidden();
  await expect(alice.locator('#result-list')).toContainText('pts');

  // New game → lobby, series gone, cup rewound to race 1 for a rematch.
  await alice.click('#newgame-btn');
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
  expect(await page.evaluate(() => ({ series: window.__series(), track: window.__net.trackId, mode: window.__net.mode })))
    .toEqual({ series: null, track: BEACH[0], mode: 'cup' });
  await expect(alice.locator(visible('#lobby'))).toBeVisible();
});

test('an untouched intermission auto-advances into the next race', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 1200; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await startRace(alice, []);
  await waitForRacing(page);

  await finishHumans(page);
  await inResults(page);
  // Nobody taps anything: the shortened intermission chains into race 2 by itself.
  await waitForRacing(page);
  expect(await page.evaluate(() => window.__net.trackId)).toBe(BEACH[1]);
  expect(await page.evaluate(() => window.__series().raceIndex)).toBe(1);
});

test('"End cup early" cancels the series and a restart begins at race 1', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await startRace(alice, []);
  await waitForRacing(page);

  await finishHumans(page);
  await inResults(page);
  await alice.click('#quitcup-btn');
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
  expect(await page.evaluate(() => window.__series())).toBe(null);
  await expect(alice.locator(visible('#lobby'))).toBeVisible();

  // A fresh Start races the cup from the top, not from where it was abandoned.
  await startRace(alice, []);
  await waitForRacing(page);
  expect(await page.evaluate(() => ({ race: window.__series().raceIndex, track: window.__net.trackId })))
    .toEqual({ race: 0, track: BEACH[0] });
});

test('Random runs an endless series of drawn tracks until the host ends it', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  // The Beach auto-pick lands first (fresh phone); then the host taps 🎲, which
  // lands on the 4-race card, and opens its panel for the endless run.
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await alice.locator('.mode-opt', { hasText: 'Random' }).click();
  await page.waitForFunction(() => window.__net.mode === 'random' && window.__net.trackId != null, null, { timeout: 10000 });
  await alice.locator('.modepick__opts .mode-opt', { hasText: 'Endless' }).click();
  await page.waitForFunction(() => window.__net.randomRaces === 0, null, { timeout: 10000 });
  const first = await page.evaluate(() => window.__net.trackId);

  await startRace(alice, []);
  await waitForRacing(page);
  await finishHumans(page);
  await inResults(page);
  // Endless intermission: numbered but not "of N", always a next draw on deck,
  // and the ghost reads as the way OUT (there is no podium to reach).
  await expect(page.locator('#results-sub')).toHaveText('Random · Race 1');
  await expect(page.locator(visible('#results-next'))).toBeVisible();
  await expect(alice.locator('#newgame-btn')).toHaveText('Next race ▸');
  await expect(alice.locator('#quitcup-btn')).toHaveText('Back to lobby');

  await alice.click('#newgame-btn');
  await waitForRacing(page);
  expect(await page.evaluate(() => window.__net.trackId)).not.toBe(first); // the bag never repeats back-to-back
  expect(await page.evaluate(() => window.__series().finished)).toBe(false);

  await finishHumans(page);
  await inResults(page);
  await expect(page.locator('#results-sub')).toHaveText('Random · Race 2');
  await alice.click('#quitcup-btn'); // the only way an endless run ends
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
  expect(await page.evaluate(() => ({ series: window.__series(), mode: window.__net.mode })))
    .toEqual({ series: null, mode: 'random' });
});

// The default half of Random: the bare tile is a fixed card, a cup made of
// tracks nobody chose — numbered "of N", and it ENDS.
test('Random defaults to a fixed 4-race card', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await alice.locator('.mode-opt', { hasText: 'Random' }).click();
  await page.waitForFunction(() => window.__net.mode === 'random' && window.__net.randomRaces === 4, null, { timeout: 10000 });
  const drawn = await page.evaluate(() => window.__net.trackId);
  expect(drawn).not.toBe(null);
  await expect(page.locator('.cup-races')).toHaveText('4 races');

  // Changing the LENGTH keeps the drawn track — the button chose a run, not a
  // circuit — in both directions.
  await alice.locator('.modepick__opts .mode-opt', { hasText: 'Endless' }).click();
  await page.waitForFunction(() => window.__net.randomRaces === 0, null, { timeout: 10000 });
  expect(await page.evaluate(() => window.__net.trackId)).toBe(drawn);
  await alice.locator('.modepick__opts .mode-opt', { hasText: '4 races' }).click();
  await page.waitForFunction(() => window.__net.randomRaces === 4, null, { timeout: 10000 });
  expect(await page.evaluate(() => window.__net.trackId)).toBe(drawn);

  await startRace(alice, []);
  await waitForRacing(page);
  expect(await page.evaluate(() => window.__net.trackId)).toBe(drawn); // race 1 IS the preview
  await finishHumans(page);
  await inResults(page);
  await expect(page.locator('#results-sub')).toHaveText('Random · Race 1 of 4');
  expect(await page.evaluate(() => ({ endless: window.__series().endless, races: window.__series().raceCount })))
    .toEqual({ endless: false, races: 4 });
});

test('a mid-cup joiner is seated into the next series race and scores from there', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await startRace(alice, []);
  await waitForRacing(page);

  // Carol arrives during race 1: waiting lobby, listed "Next race" on the board.
  const carol = await joinController(browser, roomCode, 'Carol');
  await expect(carol.locator('#ready-note')).toContainText('next race');
  await finishHumans(page);
  await inResults(page);
  await expect(page.locator('#results-list')).toContainText('Carol');
  await expect(page.locator('#results-list')).toContainText('Next race');

  // The chained start seats her: with no GAME_END mid-cup, the race-2 COUNTDOWN
  // snapshot (roomState + inRace) is what flips her phone from the waiting lobby
  // to the wheel. Record from the chain onward and note who's seated, so we can
  // prove that first snapshot already marks BOTH racers in (same guard as
  // flow.spec.js, on the series-advance path: launchRace must build the race-2
  // session BEFORE flipping to COUNTDOWN, or Carol flashes "next race" through
  // the whole countdown and only lands on the wheel at GO).
  await page.evaluate(() => {
    window.__snaps = [];
    const p = window.__net.party, orig = p.setState.bind(p);
    p.setState = (payload) => { window.__snaps.push(JSON.parse(JSON.stringify(payload))); return orig(payload); };
  });
  const seated = await page.evaluate(() => window.__net.flow.list().filter((p) => p.connected).map((p) => p.peerIndex));

  await alice.click('#newgame-btn');
  await waitForRacing(page);
  expect(await page.evaluate(() =>
    window.__session().carIds().filter((k) => !String(k).startsWith('ai-')).length)).toBe(2);
  await expect(carol.locator(visible('#game'))).toBeVisible();

  const midRace = await page.evaluate((seated) => {
    const mid = window.__snaps.filter((s) => s.roomState === 'countdown' || s.roomState === 'playing');
    const offenders = mid.flatMap((s) => (s.players || [])
      .filter((pl) => seated.includes(pl.peerIndex) && pl.inRace === false)
      .map((pl) => ({ roomState: s.roomState, peerIndex: pl.peerIndex })));
    const firstCountdownOk = mid.length > 0 && mid[0].roomState === 'countdown'
      && seated.every((i) => mid[0].players.some((pl) => pl.peerIndex === i && pl.inRace === true));
    return { offenders, firstCountdownOk };
  }, seated);
  expect(midRace.offenders).toEqual([]);
  expect(midRace.firstCountdownOk).toBe(true);

  // She scores from race 2 on: the next board carries a points row for her.
  await finishHumans(page);
  await inResults(page);
  await expect(carol.locator(visible('#results'))).toBeVisible();
  await expect(carol.locator('#result-list')).toContainText('Carol');
  await expect(carol.locator('#result-list')).toContainText('pts');
});
