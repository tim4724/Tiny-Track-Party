// @ts-check
// The feedback form (controller/feedback.js): asked once, on the board that
// ends a cup, and sent only on the player's tap. Two things no other spec sees:
// WHAT leaves the phone (the payload is the privacy policy's subject, so its
// shape is pinned here), and whether the form FITS a landscape phone with the
// browser bar up, which is a measurement, not a screenshot.
const { test, expect, openDisplay, joinController, startRace, waitForRacing, finishHumans, inResults } = require('./helpers');

const ENDPOINT = 'https://paperballoon.games/api/feedback';
const SHORT = [{ width: 844, height: 300 }, { width: 568, height: 270 }];

// WebKit's run of this fit is in webkit-controller-layout.spec.js.
const fits = (engine) => { for (const vp of SHORT) {
  test(`${engine} feedback fits ${vp.width}x${vp.height}: the question, the form, typing and what's sent`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/controller/index.html?scenario=cup-podium-settled&color=0');
    const inView = async (sel) => {
      const boxes = await page.$$eval(sel, (els) => els.filter((e) => e.offsetParent).map((e) => {
        const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      }));
      expect(boxes.length).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.bottom).toBeLessThanOrEqual(vp.height);
        expect(b.right).toBeLessThanOrEqual(vp.width);
      }
    };

    await expect(page.locator('#result-ask')).toBeVisible();
    await inView('#results-title, #result-me, #newgame-btn, #result-ask .fb-face');

    await page.locator('#result-ask .fb-face').nth(3).click();
    await expect(page.locator('#fb-form')).toBeVisible();
    await expect(page.locator('#fb-faces .fb-face[aria-checked="true"]')).toHaveCount(1);
    await inView('#fb-form button, #fb-title');

    await page.locator('.fb-field[data-field="disliked"]').click();
    await expect(page.locator('#fb-input')).toBeFocused();
    await inView('#fb-input, #fb-done');
    // A pasted line break becomes a space.
    await page.locator('#fb-input').fill('The\nrocket');
    await expect(page.locator('#fb-input')).toHaveValue('The rocket');
    // Enter is the keyboard's Done (it wears a checkmark), never a new line.
    await page.locator('#fb-input').press('Enter');
    await expect(page.locator('#fb-form')).toBeVisible();
    await expect(page.locator('#fb-disliked')).toHaveText('The rocket');

    await page.locator('#fb-whats').click();
    await inView('#fb-whatsent .fb-stat, #fb-whatsent .fb__note, #fb-back');
  });
} };
fits('chromium');

test('the last board asks before the TV\'s reveal settles; a board between races never asks', async ({ page }) => {
  await page.goto('/controller/index.html?scenario=cup-podium&color=0');
  await expect(page.locator('#results-title')).toHaveText('Race 4 of 4');
  await expect(page.locator('#result-ask')).toBeVisible();
  await page.goto('/controller/index.html?scenario=intermission&color=0');
  await expect(page.locator('#result-me')).toBeVisible();
  await expect(page.locator('#result-ask')).toBeHidden();
});

test('a finished cup asks once, and Send posts ratings plus this phone\'s race stats', async ({ page, browser }) => {
  await page.addInitScript(() => { window.__intermissionMs = 60000; });
  const roomCode = await openDisplay(page);
  const alice = await joinController(browser, roomCode, 'Alice');
  const bob = await joinController(browser, roomCode, 'Bob');
  let posted = null;
  await alice.route(ENDPOINT, (route) => {
    posted = { type: route.request().headers()['content-type'], body: JSON.parse(route.request().postData() || 'null') };
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });

  await page.waitForFunction(() => window.__net.mode === 'cup' && window.__net.trackId != null, null, { timeout: 10000 });
  await startRace(alice, [bob]);
  await waitForRacing(page);
  for (let race = 1; race <= 3; race++) {
    await finishHumans(page);
    await inResults(page);
    await expect(alice.locator('#newgame-btn')).toHaveText('Next race ▸');
    await expect(alice.locator('#result-ask')).toBeHidden();   // an intermission is not the end
    await alice.click('#newgame-btn');
    await waitForRacing(page);
  }
  await finishHumans(page);
  await inResults(page);
  await expect(alice.locator('#results-title')).toContainText('Final', { timeout: 30000 });
  await expect(alice.locator('#result-ask')).toBeVisible();
  await expect(bob.locator('#result-ask')).toBeVisible();

  await alice.locator('#result-ask .fb-face').nth(4).click();
  await expect(alice.locator('#fb-title')).toHaveText('How was the Beach Cup?');
  await alice.locator('[data-set="bots"] [data-value="too-hard"]').click();
  await alice.locator('.fb-field[data-field="liked"]').click();
  await alice.locator('#fb-input').fill('  The jumps  ');
  await alice.locator('#fb-done').click();
  await alice.locator('#fb-send').click();

  await expect(alice.locator('#fb-thanks')).toBeVisible();
  await expect(alice.locator('#result-ask-done')).toBeVisible({ timeout: 5000 });
  await expect(alice.locator('#result-ask .fb-face').first()).toBeHidden();   // asked once
  await expect(alice.locator('#feedback-overlay')).toBeHidden();

  expect(posted.type).toContain('text/plain');   // a simple request: no preflight
  const p = posted.body;
  expect(p).toMatchObject({
    v: 1, game: 'tinytrack', fun: 5, answers: { bots: 'too-hard' }, liked: 'The jumps',
    data: { cup: { id: 'beach', name: 'Beach Cup' } }
  });
  expect(p.answers.controls).toBeUndefined();
  expect(p.disliked).toBeUndefined();
  // Nothing that names anyone: no player name, no room code, anywhere in it.
  const wire = JSON.stringify(p);
  expect(wire).not.toContain('Alice');
  expect(wire).not.toContain('Bob');
  expect(wire).not.toContain(roomCode);
  // What ties one couch's reports together is derived from the race result, not the room.
  expect(p.session).toMatch(/^[a-z0-9]{11}$/);
  const st = p.data.stats;
  expect(st.races).toHaveLength(4);
  for (const r of st.races) {
    expect(r.order).toHaveLength(8);
    expect(r.order.filter((o) => o.startsWith('you:'))).toHaveLength(1);
    expect(r.order.filter((o) => o.startsWith('human:'))).toHaveLength(1);
    expect(r.order.filter((o) => o === 'bot')).toHaveLength(6);
    expect(r.t).toBeGreaterThan(0);   // the winner's time: with track and order, the race's fingerprint
  }
  expect(st.races.map((r) => r.track)).toEqual(['tidepool', 'cove', 'driftwood', 'riptide']);
  expect(st.link.direct).toHaveLength(9);
  expect(st.link.relay).toHaveLength(9);
  expect(['open', 'failed', 'no-webrtc']).toContain(st.fastlane.result);
  expect(st.device.app).toBe(false);
  expect(['web', 'unknown']).toContain(st.device.tv);   // 'web' rides the QR's ?pbp=, which this join skips

  // With the switch off, the same form sends the answers and nothing else.
  await bob.route(ENDPOINT, (route) => {
    posted = { body: JSON.parse(route.request().postData() || 'null') };
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });
  await bob.locator('#result-ask .fb-face').nth(1).click();
  await bob.locator('#fb-stats').click();
  await bob.locator('#fb-send').click();
  await expect(bob.locator('#fb-thanks')).toBeVisible();
  expect(posted.body.data.stats).toBeUndefined();
  expect(posted.body.session).toBeUndefined();
  expect(posted.body.fun).toBe(2);
  expect(posted.body.answers).toEqual({});
});

// The gallery's feedback cards go through the live panes, so each one is pinned
// here: a renamed pane would otherwise answer the bare board, not an error.
test('every feedback pane has its gallery scenario', async ({ page }) => {
  const shows = {
    'feedback-form': '#fb-form',
    'feedback-typing': '#fb-typing',
    'feedback-whats-sent': '#fb-whatsent',
    'feedback-thanks': '#fb-thanks'
  };
  for (const [scenario, pane] of Object.entries(shows)) {
    await page.goto(`/controller/index.html?scenario=${scenario}&color=2`);
    await expect(page.locator(pane)).toBeVisible();
    await expect(page.locator('.fb__pane:visible')).toHaveCount(1);
  }
  await page.goto('/controller/index.html?scenario=feedback-sent&color=2');
  await expect(page.locator('#result-ask-done')).toBeVisible();
  await expect(page.locator('#result-ask .fb-face').first()).toBeHidden();
  await expect(page.locator('#feedback-overlay')).toBeHidden();
});
