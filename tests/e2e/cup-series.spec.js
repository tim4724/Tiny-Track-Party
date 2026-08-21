// @ts-check
// Grand Prix cups: a fresh host auto-picks the Beach Cup, so Start commits to
// its 4 tracks back-to-back — intermission standings between races (host can
// advance early; otherwise it auto-advances), podium after race 4,
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
  // Baseline for the in-loop guard below: the cell HUD is up in race 1.
  await expect(page.locator('.cell-label').first()).toBeVisible();

  // Races 1-3: finish → intermission board on both screens → host taps "Next race".
  for (let race = 1; race <= 3; race++) {
    await finishHumans(page);
    await inResults(page);
    await expect(page.locator('#results-sub')).toContainText(`Race ${race} of 4`);
    await expect(page.locator('#results-next')).toContainText(BEACH[race].charAt(0).toUpperCase() + BEACH[race].slice(1));
    await expect(alice.locator('#newgame-btn')).toHaveText('Next race ▸');
    await expect(bob.locator('#result-wait')).toContainText('starting soon');
    // The next circuit is MESHED UNDER THIS BOARD (main.js prepareNextTrack), not
    // under the countdown that follows it — a scene build blocks the main thread
    // for a few hundred ms, and performed at the chained start that is a stutter
    // with the countdown already ticking over the OUTGOING track. A timeout here
    // means the prepare stopped happening.
    await page.waitForFunction((id) => window.__scene._track.id === id, BEACH[race], { timeout: 15000 });
    await alice.click('#newgame-btn');
    await waitForRacing(page);
    expect(await page.evaluate(() => window.__net.trackId)).toBe(BEACH[race]);
    // The cell HUD (name/item/place/lap) must come back in EVERY chained race.
    // The bug: reset-scene-cars recreates the CSS-hidden HUD elements, and when
    // the new layout signature matches Stage's placement latch (same seats,
    // same rects, and no finish flag ever painted — the race ends the same
    // frame the last human crosses), the placement pass was skipped and the
    // HUD stayed display:none for every following race until a window resize.
    await expect(page.locator('.cell-label').first()).toBeVisible();
    await expect(page.locator('.cell-rank').first()).toBeVisible();
  }

  // Race 4: finish → podium. The TV board opens on the RACE like every cup board,
  // then accounts the points one at a time, and only crowns the champion once the
  // last one has landed — some seconds after `inResults` goes true. The generous
  // timeout is that animation plus the scene teardown that can block the page
  // through it, not slack for a hang.
  await finishHumans(page);
  await inResults(page);
  await expect(page.locator('#results-title')).toHaveText('Beach Cup CHAMPS!', { timeout: 20000 });
  await expect(page.locator('#results-list li.is-medal-1')).toHaveCount(1);
  await expect(alice.locator('#results-title')).toContainText('Beach Cup · Final');
  await expect(alice.locator('#newgame-btn')).toHaveText('New game');
  // …and only NOW do the phones report the cup: the display pushes the standings
  // a second time once its reveal has landed (showResults' settled callback), so
  // the card swaps off the race place onto the cup finish. Before that push it
  // is still showing the race — which is the whole point of sending it twice.
  await expect(alice.locator('#results-title')).toContainText('Beach Cup · Final');
  await expect(alice.locator('#result-time')).toContainText('pts');

  // The finished GP BANKED: the persist-progression effect wrote the engine's
  // record to localStorage. Both humans out-finish the fast-forwarded AI in
  // every race (their synthetic times beat any full race), so the series
  // winner is human and beach banks best=1 — the exact blob, no more keys.
  await page.waitForFunction(() => !!localStorage.getItem('tinytrack_progress'), null, { timeout: 5000 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tinytrack_progress'))))
    .toEqual({ v: 1, cups: { beach: { best: 1 } } });

  // New game → lobby, series gone, cup rewound to race 1 for a rematch.
  await alice.click('#newgame-btn');
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
  expect(await page.evaluate(() => ({ series: window.__series(), track: window.__net.trackId, mode: window.__net.mode })))
    .toEqual({ series: null, track: BEACH[0], mode: 'cup' });
  await expect(alice.locator(visible('#lobby'))).toBeVisible();

  // …and the couch SEES the bank: the shelf's Beach row wears the won cup's
  // three stars, the locked Playroom's unlock count moved to 1/4, and the
  // host's RACE page draws the same stars off the republished snapshot —
  // engine record → localStorage → chooser → both screens, end to end.
  await expect(page.locator('.cup-shelf__row', { hasText: 'Beach' })
    .locator('.star:not(.star--off)')).toHaveCount(3);
  await expect(page.locator('.cup-shelf__row--locked')).toContainText('1/4');
  // The corner button IS the stepper — there is no tab strip; on the car page
  // its forward face reads "Select race".
  await alice.click('#ready-btn');
  await expect(alice.locator('.mode-opt', { hasText: 'Beach Cup' })
    .locator('.star:not(.star--off)')).toHaveCount(3);
});

test('an untouched intermission auto-advances into the next race', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 1200; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await startRace(alice, []);
  await waitForRacing(page);

  await finishHumans(page);
  // Nobody taps anything: the shortened intermission chains into race 2 by
  // itself. The 1.2 s results window is too brief to OBSERVE reliably (rAF
  // polling misses it under load), so assert the outcome instead — race 2 is
  // reachable only through RESULTS (startRace's LOBBY guard keeps every other
  // path out), so racing BEACH[1] proves the intermission happened and chained.
  await page.waitForFunction((id) => window.__net.trackId === id, BEACH[1], { timeout: 30000 });
  await waitForRacing(page);
  expect(await page.evaluate(() => window.__series().raceIndex)).toBe(1);
});

test('abandoning a cup mid-race cancels the series and a restart begins at race 1', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await startRace(alice, []);
  await waitForRacing(page);

  await finishHumans(page);
  await inResults(page);
  // The intermission board offers no way out — it advances, or it waits. The
  // exit from a running cup is the pause overlay, one race later.
  await alice.click('#newgame-btn');
  await waitForRacing(page);
  await alice.click('#pause-btn');
  await alice.click('#pause-newgame');

  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
  expect(await page.evaluate(() => window.__series())).toBe(null);
  await expect(alice.locator(visible('#lobby'))).toBeVisible();
  // The lobby attracts on the circuit its own card names. Quitting DURING race 2
  // is the case that can break this: the scene is standing on race 2's track and
  // the rewind to race 1 moves no pick — so nothing would put the scene back
  // unless fade-to-lobby places it anyway.
  await page.waitForFunction((id) => window.__scene._track.id === id, BEACH[0], { timeout: 15000 });

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
  // lands on the World Tour (the tile's default), and opens the panel for the
  // endless run.
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await alice.click('#ready-btn');  // "Select race" — the corner steps to the picker page
  await alice.locator('.mode-opt', { hasText: 'Random' }).click();
  await page.waitForFunction(() => window.__net.mode === 'tour' && window.__net.trackId != null, null, { timeout: 10000 });
  await alice.locator('.modepick__tracks .track-opt', { hasText: 'Endless' }).click();
  await page.waitForFunction(() => window.__net.randomRaces === 0, null, { timeout: 10000 });
  const first = await page.evaluate(() => window.__net.trackId);
  // An endless card promises nothing at all: one grey box carrying ∞ — no
  // track layout, no boxes it can't count, no extra badge.
  await expect(page.locator('.cup-maps .cup-maps__tile--q')).toHaveCount(1);
  await expect(page.locator('.cup-maps .cup-maps__tile--q')).toHaveText('∞');
  await expect(page.locator('.cup-maps .track-map')).toHaveCount(0);

  await startRace(alice, []);
  await waitForRacing(page);
  await finishHumans(page);
  await inResults(page);
  // Endless intermission: numbered but not "of N", always a next draw on deck.
  await expect(page.locator('#results-sub')).toHaveText('Random · Race 1');
  await expect(page.locator(visible('#results-next'))).toBeVisible();
  await expect(alice.locator('#newgame-btn')).toHaveText('Next race ▸');

  await alice.click('#newgame-btn');
  await waitForRacing(page);
  expect(await page.evaluate(() => window.__net.trackId)).not.toBe(first); // the bag never repeats back-to-back
  expect(await page.evaluate(() => window.__series().finished)).toBe(false);

  await finishHumans(page);
  await inResults(page);
  await expect(page.locator('#results-sub')).toHaveText('Random · Race 2');
  // An endless run has no podium to reach, so pausing out of a race is the only
  // way it ever ends.
  await alice.click('#newgame-btn');
  await waitForRacing(page);
  await alice.click('#pause-btn');
  await alice.click('#pause-newgame');
  await page.waitForFunction(() => window.__net.roomState === 'lobby', null, { timeout: 10000 });
  expect(await page.evaluate(() => ({ series: window.__series(), mode: window.__net.mode })))
    .toEqual({ series: null, mode: 'random' });
});

// The fixed random cards: a cup made of tracks nobody chose — numbered "of N",
// and it ENDS. The 🎲 tile itself lands on the World Tour, so a length is
// always an explicit second tap — and EVERY family tap deals fresh track(s),
// a re-tap of the same option included.
test('every random tap deals a fresh draw; the fixed cards stay secret', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  const trackNow = () => page.evaluate(() => window.__net.trackId);
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await alice.click('#ready-btn');  // "Select race" — the corner steps to the picker page
  await alice.locator('.mode-opt', { hasText: 'Random' }).click();
  await page.waitForFunction(() => window.__net.mode === 'tour', null, { timeout: 10000 });
  await alice.locator('.modepick__tracks .track-opt', { hasText: '4 races' }).click();
  await page.waitForFunction(() => window.__net.mode === 'random' && window.__net.randomRaces === 4, null, { timeout: 10000 });
  const drawn = await trackNow();
  expect(drawn).not.toBe(null);
  await expect(page.locator('.cup-races')).toHaveText('4 races');
  // The card spoils nothing — four grey "?" boxes, the drawn race included.
  await expect(page.locator('.cup-maps .cup-maps__tile--q')).toHaveCount(4);
  await expect(page.locator('.cup-maps .track-map')).toHaveCount(0);

  // A length change deals a fresh draw (the bag never repeats back-to-back).
  await alice.locator('.modepick__tracks .track-opt', { hasText: 'Endless' }).click();
  await page.waitForFunction(() => window.__net.randomRaces === 0, null, { timeout: 10000 });
  const endlessDraw = await trackNow();
  expect(endlessDraw).not.toBe(drawn);

  // The LONG card (the manifest's MAX worn as an option): fresh draw again,
  // and the card grows to 8 grey "?" boxes.
  await alice.locator('.modepick__tracks .track-opt', { hasText: '8 races' }).click();
  await page.waitForFunction(() => window.__net.randomRaces === 8, null, { timeout: 10000 });
  const longDraw = await trackNow();
  expect(longDraw).not.toBe(endlessDraw);
  await expect(page.locator('.cup-races')).toHaveText('8 races');
  await expect(page.locator('.cup-maps .cup-maps__tile--q')).toHaveCount(8);

  await alice.locator('.modepick__tracks .track-opt', { hasText: '4 races' }).click();
  await page.waitForFunction(() => window.__net.randomRaces === 4, null, { timeout: 10000 });
  const back4 = await trackNow();

  // Re-tapping the SAME length deals again too — nothing on the pick changes
  // except the draw itself.
  await alice.locator('.modepick__tracks .track-opt', { hasText: '4 races' }).click();
  await page.waitForFunction((prev) => window.__net.trackId !== prev, back4, { timeout: 10000 });

  // ...and so does the main 🎲 tile, which re-sends the current pick.
  const beforeDice = await trackNow();
  await alice.locator('.mode-opt', { hasText: 'Random' }).first().click();
  await page.waitForFunction((prev) => window.__net.trackId !== prev, beforeDice, { timeout: 10000 });
  const rerolled = await trackNow();

  await startRace(alice, []);
  await waitForRacing(page);
  expect(await trackNow()).toBe(rerolled); // race 1 IS the preview
  await finishHumans(page);
  await inResults(page);
  await expect(page.locator('#results-sub')).toHaveText('Random · Race 1 of 4');
  expect(await page.evaluate(() => ({ endless: window.__series().endless, races: window.__series().raceCount })))
    .toEqual({ endless: false, races: 4 });
});

// The World Tour: one drawn track from every cup, raced in the cups' own
// (difficulty) order — beach first, so race 1 is a beach draw. The card
// spoils none of it: five per-cup "?" boxes, the drawn race included.
test('World Tour draws one track per cup and races them in cup order', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  await page.waitForFunction(() => window.__net.mode === 'cup', null, { timeout: 10000 });
  await alice.click('#ready-btn');  // "Select race" — the corner steps to the picker page
  // The auto-picked cup's detail panel is open; remember its height — Random's
  // run panel must occupy the exact same space (same header, same grid, same
  // tile anatomy), so switching rows moves nothing on the phone.
  await alice.waitForSelector('.modepick__tracks .track-opt');
  const cupPanelH = await alice.evaluate(() => document.querySelector('.modepick__tracks').offsetHeight);
  // The 🎲 tile's DEFAULT is the tour — one tap from a cup lands on it.
  await alice.locator('.mode-opt', { hasText: 'Random' }).first().click();
  await page.waitForFunction(() => window.__net.mode === 'tour' && window.__net.trackId != null, null, { timeout: 10000 });
  const rndPanelH = await alice.evaluate(() => document.querySelector('.modepick__tracks').offsetHeight);
  expect(Math.abs(rndPanelH - cupPanelH)).toBeLessThanOrEqual(1);
  const first = await page.evaluate(() => window.__net.trackId);
  expect(BEACH).toContain(first); // race 1 is drawn from the FIRST cup

  // The race card: the WHOLE ladder — four cup-tinted "?" boxes plus the
  // locked Playroom's padlock teaser, nothing spoiled (the drawn beach race
  // included). A fresh couch has the Playroom locked, so the teaser counts no
  // race; it becomes a fifth "?" with the unlock (the progression ctests own
  // that rule).
  await expect(page.locator('.cup-maps .cup-maps__tile--q')).toHaveCount(4);
  await expect(page.locator('.cup-maps .cup-maps__tile--locked')).toHaveCount(1);
  await expect(page.locator('.cup-maps .track-map')).toHaveCount(0);
  await expect(page.locator('.cup-races')).toHaveText('4 races');
  await expect(page.locator('.cup-sticker')).toHaveText('World Tour');

  await startRace(alice, []);
  await waitForRacing(page);
  expect(await page.evaluate(() => window.__net.trackId)).toBe(first);
  await finishHumans(page);
  await inResults(page);
  await expect(page.locator('#results-sub')).toHaveText('World Tour · Race 1 of 4');
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
    // The retained snapshot is composed AND FRAMED in C++ now
    // (ttp_net_lobby_frame), so the display publishes pre-encoded bytes through
    // setStateFrame rather than handing setState an object. Unwrap the frame to
    // get back the same snapshot this hook has always collected.
    const p = window.__net.party, orig = p.setStateFrame.bind(p);
    p.setStateFrame = (frame) => { window.__snaps.push(JSON.parse(frame).data); return orig(frame); };
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

  // She RACED this one: her card now reports a finishing place, where the round
  // she sat out gave her the "next race" placeholder and no place at all.
  await finishHumans(page);
  await inResults(page);
  await expect(carol.locator(visible('#results'))).toBeVisible();
  await expect(carol.locator('#result-place')).toHaveText(/^\d+(st|nd|rd|th)$/);
});
