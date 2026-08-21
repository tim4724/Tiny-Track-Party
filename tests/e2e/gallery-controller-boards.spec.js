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
test('phone race page: the pick list carries stars; the first cup detail is open', async ({ page }) => {
  await page.goto(`${CONTROLLER}lobby-race&color=1`);
  await page.waitForSelector('.racelist .mode-opt');
  // Cups in ladder order plus Random last — 6 rows for a 5-cup catalogue.
  await expect(page.locator('.racelist .mode-opt')).toHaveCount(6);
  // Stars only the payload can produce: Beach earned 3, Canyon none.
  await expect(page.locator('.racelist .mode-opt', { hasText: 'Beach' })
    .locator('.star:not(.star--off)')).toHaveCount(3);
  await expect(page.locator('.racelist .mode-opt', { hasText: 'Canyon' })
    .locator('.star:not(.star--off)')).toHaveCount(0);
  // The locked row trails its unlock progress, not stars.
  await expect(page.locator('.mode-opt--locked')).toContainText('3/4');
  // The auto-picked first cup's detail: header name + its four named maps.
  await expect(page.locator('.racedetail .raceinfo__name')).toHaveText('Beach Cup');
  await expect(page.locator('.modepick__tracks .track-opt')).toHaveCount(4);
});

test('phone race page: examining the locked cup swaps the detail for the unlock pitch', async ({ page }) => {
  await page.goto(`${CONTROLLER}lobby-race-locked&color=1`);
  await page.waitForSelector('.modepick__tracks--locked');
  await expect(page.locator('.racedetail .raceinfo__name')).toHaveText('Playroom Cup');
  await expect(page.locator('.racedetail .raceinfo__meta')).toContainText('Finish every cup');
  // Per-cup checks: three done, one to go — only the payload knows which.
  await expect(page.locator('.unlock-rules__row')).toHaveCount(4);
  await expect(page.locator('.unlock-rules__row--todo')).toHaveCount(1);
  await expect(page.locator('.unlock-rules__row--todo')).toContainText('Canyon');
  await expect(page.locator('.unlock-rules__foot')).toHaveText('3 of 4 done');
  // The pick itself is untouched: the locked row is the CURSOR, not the pick.
  await expect(page.locator('.mode-opt--locked')).toHaveClass(/mode-opt--cursor/);
});
