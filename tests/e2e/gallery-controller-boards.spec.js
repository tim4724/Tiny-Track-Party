// @ts-check
// The PHONE's results previews render through the live board renderer
// (controller/resultsBoard.js) fed a synthesized STANDINGS payload — the same
// no-drift arrangement the display's boards use (see gallery-boards.spec.js).
// The harness used to hand-roll its own twin of this markup and had already
// drifted: the race board never set #results-title, and the cup board hardcoded
// "Race 2 of 4" instead of deriving it from the series.
//
// The shape contract is the thing to gate. A field renamed on the payload
// (`series`, `final`, `finished`, `gained`, `racePlace`…) does not throw — it
// quietly answers a PLAINER dressing, so a finished cup board renders as if the
// race were still running. That exact bug shipped in the first draft of the
// synthesized payload: rows without `finished` all came back still-racing. Each
// case below pins something only the right payload can produce.
//
// The board shows YOU, and only your RACE place. What is gated here is that the
// card resolves the right player out of the payload, reads `racePlace` (not the
// row's position, which on a cup board is the cup ranking), and never leaks the
// cup standing — the TV reveals that by counting the points across, and a phone
// printing it on arrival hands four people the answer early.
const { test, expect } = require('./helpers');

const CONTROLLER = '/controller/index.html?scenario=';

// Pure DOM, no relay and no scene — the board is painted as soon as the module
// graph lands, so a non-empty title is enough to know the scenario ran.
async function boardReady(page) {
  await page.waitForFunction(() => {
    const t = document.getElementById('results-title');
    return t && t.textContent && t.textContent.length > 0;
  }, null, { timeout: 30000 });
}

test('phone results board: my finishing place and time, host gets New game', async ({ page }) => {
  await page.goto(`${CONTROLLER}results&color=1`);
  await boardReady(page);
  // A single race has no series, which is the only way to reach this title.
  await expect(page.locator('#results-title')).toHaveText('Results');
  // The card is MINE, not row 1's: in this board I came 2nd. Reading the wrong
  // player (or the array head) is the failure this pins.
  await expect(page.locator('#result-place')).toHaveText('2nd');
  await expect(page.locator('#result-time')).toHaveText('31.2s');
  // The board is over and viewed as the host.
  await expect(page.locator('#newgame-btn')).toHaveText('New game');
  await expect(page.locator('#result-wait')).toBeHidden();
});

test('phone results board mid-race: my time, the field still out', async ({ page }) => {
  await page.goto(`${CONTROLLER}finished&color=1`);
  await boardReady(page);
  await expect(page.locator('#results-title')).toHaveText('Results');
  // The point of this screen: I am home, the others are not. `over:false` plus
  // per-row `finished` is what separates them.
  await expect(page.locator('#result-place')).toHaveText('1st');
  await expect(page.locator('#result-time')).toHaveText('31.2s');
  // Nobody may start anything while cars are still out.

  await expect(page.locator('#newgame-btn')).toBeHidden();
  await expect(page.locator('#result-wait')).toHaveText('Waiting for the other racers to finish…');
});

test('phone cup intermission: my RACE place only, race counter, one host button', async ({ page }) => {
  await page.goto(`${CONTROLLER}intermission&color=1`);
  await boardReady(page);
  // Derived from series.raceIndex/raceCount — the harness used to hardcode this.
  await expect(page.locator('#results-title')).toHaveText('Race 2 of 4');
  // The card shows the RACE place. This board is in cup order and I am 2nd in
  // it, so a card reading its row position instead of `racePlace` would say
  // "2nd" here — and look entirely plausible doing it.
  await expect(page.locator('#result-place')).toHaveText('1st');
  await expect(page.locator('#result-time')).toHaveText('28.4s');
  // NO cup standing, and no points: that is the TV's reveal to make.
  await expect(page.locator('#result-me')).not.toContainText('pts');
  await expect(page.locator('#result-me')).not.toContainText('+');
  // Mid-series ⇒ advance, and that is the WHOLE footer: an intermission offers
  // no way to abandon the cup (leaving is the pause overlay's "New game").
  await expect(page.locator('#newgame-btn')).toHaveText('Next race ▸');
  await expect(page.locator('#result-foot button:visible')).toHaveCount(1);
});

// The last board of a cup has TWO states and the phone must not confuse them.
// In this scenario I came 3rd in the last race and still took the cup, so a card
// wired to the wrong ranking — or a title that does not move with it — shows a
// different number, rather than looking plausible because the two agreed.
test('phone cup last race: still the RACE, while the TV is revealing', async ({ page }) => {
  await page.goto(`${CONTROLLER}cup-podium&color=1`);
  await boardReady(page);
  // NOT "Beach Cup · Final": the TV is still counting points towards the
  // champion, and a phone titling this the final over a RACE place would tell
  // whoever won the last race that they had won the cup.
  await expect(page.locator('#results-title')).toHaveText('Race 4 of 4');
  await expect(page.locator('#result-place')).toHaveText('3rd');
  await expect(page.locator('#result-me')).not.toContainText('pts');
  // The cup is done: back to the lobby.
  await expect(page.locator('#newgame-btn')).toHaveText('New game');
});

test('phone cup final: reports the CUP once the TV has revealed it', async ({ page }) => {
  await page.goto(`${CONTROLLER}cup-podium-settled&color=1`);
  await boardReady(page);
  // `settled` is the display's second push, sent when its reveal lands. Both the
  // title and the card move together onto the cup.
  await expect(page.locator('#results-title')).toHaveText(/ · Final$/);
  await expect(page.locator('#result-place')).toHaveText('1st');
  await expect(page.locator('#result-time')).toHaveText('36 pts');
  await expect(page.locator('#newgame-btn')).toHaveText('New game');
});

// The RACE page's progression dressings — same contract as the boards above:
// each assertion pins something only the right `progress` payload can produce
// (a renamed field degrades to a starless, lock-less picker rather than throw).
test('phone race page: the grid carries stars and the lock, and the ribbon the key', async ({ page }) => {
  await page.goto(`${CONTROLLER}lobby-race&color=1`);
  await page.waitForSelector('.racelist .mode-opt');
  // Cups in ladder order plus the three random runs — 8 tiles for a 5-cup
  // catalogue, and nothing else on the page: this page IS the grid.
  await expect(page.locator('.racelist .mode-opt')).toHaveCount(8);
  await expect(page.locator('.mode-opt', { hasText: 'World Tour' })).toHaveCount(1);
  await expect(page.locator('.mode-opt', { hasText: 'Endless Run' })).toHaveCount(1);
  // Stars only the payload can produce: Beach earned 3, Canyon none.
  await expect(page.locator('.racelist .mode-opt', { hasText: 'Beach' })
    .locator('.star:not(.star--off)')).toHaveCount(3);
  await expect(page.locator('.racelist .mode-opt', { hasText: 'Canyon' })
    .locator('.star:not(.star--off)')).toHaveCount(0);
  // The locked tile trails its unlock progress, not stars — and it is not a
  // choice, so it takes no tap at all. The count IS the explanation now: a
  // sentence under the grid said the same thing a page-width lower down.
  await expect(page.locator('.mode-opt--locked')).toContainText('3/4');
  expect(await page.locator('.mode-opt--locked').evaluate((e) => !!e.onclick)).toBe(false);
  // The World Tour wears one BAND PER UNLOCKED CUP, in the ladder's own order —
  // the same thing the TV's card says with one tinted chip per cup
  // (native ui_model.cc PickMode::TOUR). The preview has five cups with the
  // Playroom locked, and a locked cup is not toured (ttp_net.cc chooserCups), so
  // FOUR bands is the count that matches the races that would actually run.
  // Its two neighbours stay the flat "belongs to no cup" grey.
  const bg = (name) => page.locator('.mode-opt', { hasText: name })
    .evaluate((e) => getComputedStyle(e).backgroundImage);
  const tour = await bg('World Tour');
  expect(tour).toContain('linear-gradient');
  expect(new Set(tour.match(/(?:rgba?|color)\([^)]*\)/g)).size,
    'one band per unlocked cup').toBe(4);
  expect(await bg('Endless Run'), 'the other random runs stay flat').toBe('none');

  // The star key lives in the page's top ribbon, and ONLY on this page — the car
  // page's ratings name themselves in the tile, so a shared ribbon carrying a
  // race-page key onto it would be explaining a badge that isn't there.
  await expect(page.locator('#race-key .star-legend')).toBeVisible();
  await expect(page.locator('#race-key')).toContainText('win');
  await page.goto(`${CONTROLLER}lobby-host&color=1`);
  await page.waitForSelector('#carpick .car-opt');
  await expect(page.locator('#race-key')).toBeHidden();
});

test('phone race page: waiting on the grid gates Start, and the note clears the tiles', async ({ page }) => {
  // The host's own waiting state: Start needs everyone, so it sits disabled
  // with the floating note explaining why. Only a roster with an unready player
  // produces this — an all-ready one renders a live button and no chip at all.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(`${CONTROLLER}lobby-race-waiting&color=1`);
  await page.waitForSelector('.racelist .mode-opt');
  await expect(page.locator('#ready-btn')).toHaveText('Start race');
  await expect(page.locator('#ready-btn')).toBeDisabled();
  await expect(page.locator('#ready-note')).toHaveText(/Waiting for all players/);

  // The note shares the action row with the buttons rather than hanging over
  // them, so it has to clear the grid on its own — and the buttons must not move
  // when it arrives or goes, which is what `margin-inline: auto` buys: an auto
  // margin on EACH side eats all the free space, centring the note in whatever
  // the buttons leave while they stay pinned right.
  const box = async (sel) => page.locator(sel).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  const note = await box('#ready-note');
  const gridBottom = await page.evaluate(() => Math.max(
    ...[...document.querySelectorAll('.racelist .mode-opt')].map((e) => e.getBoundingClientRect().bottom)));
  expect(note.top, 'the note must not land on the tiles').toBeGreaterThanOrEqual(gridBottom);
  const btnLeft = await box('#ready-btn');
  expect(note.right, 'the note sits LEFT of the buttons').toBeLessThanOrEqual(btnLeft.left);

  const waiting = { grid: await box('.racelist'), btn: await box('#ready-btn'), back: await box('#lobby-back') };
  await page.goto(`${CONTROLLER}lobby-race&color=1`);
  await page.waitForSelector('.racelist .mode-opt');
  await expect(page.locator('#ready-note')).toBeEmpty();
  expect(await box('.racelist')).toEqual(waiting.grid);
  expect(await box('#ready-btn')).toEqual(waiting.btn);
  expect(await box('#lobby-back')).toEqual(waiting.back);
});
