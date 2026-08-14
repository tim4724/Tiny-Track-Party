// @ts-check
// The PHONE's results previews render through the live board renderer
// (controller/resultsBoard.js) fed a synthesized STANDINGS payload — the same
// no-drift arrangement the display's boards use (see gallery-boards.spec.js).
// The harness used to hand-roll its own twin of this markup and had already
// drifted: the race board never set #results-title, and the cup board hardcoded
// "Race 2 of 4" instead of deriving it from the series.
//
// The shape contract is the thing to gate. A field renamed on the payload
// (`series`, `final`, `finished`, `gained`…) does not throw — it quietly answers
// a PLAINER dressing, so a finished cup board renders as if everyone were still
// out on track. That exact bug shipped in the first draft of the synthesized
// payload: rows without `finished` all came back marked `is-racing`. Each case
// below pins something only the right payload can produce.
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

test('phone results board: finish times, the joining row, host gets New game', async ({ page }) => {
  await page.goto(`${CONTROLLER}results&color=1`);
  await boardReady(page);
  // A single race has no series, which is the only way to reach this title.
  await expect(page.locator('#results-title')).toHaveText('Results');
  // The full 8-car field plus the joining row.
  await expect(page.locator('#result-list li')).toHaveCount(9);
  // The joining row is a DIFFERENT shape, not a racer with blank fields.
  await expect(page.locator('#result-list li.is-joining')).toHaveCount(1);
  await expect(page.locator('#result-list li.is-joining .res-time')).toHaveText('Next race');
  // Race board ⇒ times, never points.
  await expect(page.locator('#result-list li .res-pts')).toHaveCount(0);
  // The board is over and viewed as the host.
  await expect(page.locator('#newgame-btn')).toHaveText('New game');
  await expect(page.locator('#result-wait')).toBeHidden();
});

test('phone results board mid-race: my time, everyone else still racing', async ({ page }) => {
  await page.goto(`${CONTROLLER}finished&color=1`);
  await boardReady(page);
  await expect(page.locator('#results-title')).toHaveText('Results');
  // The point of this screen: I am home, the others are not. `over:false` plus
  // per-row `finished` is what separates them — a payload that lost either would
  // mark every row the same.
  await expect(page.locator('#result-list li.is-me .res-time')).toHaveText('31.2s');
  await expect(page.locator('#result-list li.is-racing')).toHaveCount(7);
  await expect(page.locator('#result-list li.is-racing .res-time').first()).toHaveText('Racing…');
  // Nobody may start anything while cars are still out.
  await expect(page.locator('#newgame-btn')).toBeHidden();
  await expect(page.locator('#result-wait')).toHaveText('Waiting for the other racers to finish…');
});

test('phone cup intermission: points board, race counter, one host button', async ({ page }) => {
  await page.goto(`${CONTROLLER}intermission&color=1`);
  await boardReady(page);
  // Derived from series.raceIndex/raceCount — the harness used to hardcode this.
  await expect(page.locator('#results-title')).toHaveText('Race 2 of 4');
  // Cup dressing: points columns replace the lap clock.
  await expect(page.locator('#result-list li .res-pts').first()).toBeVisible();
  await expect(page.locator('#result-list li .res-time')).toHaveCount(0);
  // A finished cup board must NOT mark its rows as still out on track.
  await expect(page.locator('#result-list li.is-racing')).toHaveCount(0);
  // Mid-series ⇒ advance, and that is the WHOLE footer: an intermission offers
  // no way to abandon the cup (leaving is the pause overlay's "New game").
  await expect(page.locator('#newgame-btn')).toHaveText('Next race ▸');
  await expect(page.locator('#result-foot button:visible')).toHaveCount(1);
});

test('phone cup podium: cup-named final header', async ({ page }) => {
  await page.goto(`${CONTROLLER}cup-podium&color=1`);
  await boardReady(page);
  // series.final is the flag the harness has to spell right; without it this
  // silently falls back to the plain race counter.
  await expect(page.locator('#results-title')).toHaveText(/ — Final$/);
  await expect(page.locator('#result-list li .res-pts').first()).toBeVisible();
  await expect(page.locator('#result-list li.is-racing')).toHaveCount(0);
  // The cup is done: back to the lobby.
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
  await expect(page.locator('.raceinfo__name')).toHaveText('Beach Cup');
  await expect(page.locator('.modepick__tracks .track-opt')).toHaveCount(4);
});

test('phone race page: examining the locked cup swaps the detail for the unlock pitch', async ({ page }) => {
  await page.goto(`${CONTROLLER}lobby-race-locked&color=1`);
  await page.waitForSelector('.modepick__tracks--locked');
  await expect(page.locator('.raceinfo__name')).toHaveText('Playroom Cup');
  await expect(page.locator('.raceinfo__meta')).toContainText('Finish every cup');
  // Per-cup checks: three done, one to go — only the payload knows which.
  await expect(page.locator('.unlock-rules__row')).toHaveCount(4);
  await expect(page.locator('.unlock-rules__row--todo')).toHaveCount(1);
  await expect(page.locator('.unlock-rules__row--todo')).toContainText('Canyon');
  await expect(page.locator('.unlock-rules__foot')).toHaveText('3 of 4 done');
  // The pick itself is untouched: the locked row is the CURSOR, not the pick.
  await expect(page.locator('.mode-opt--locked')).toHaveClass(/mode-opt--cursor/);
});
