// @ts-check
// The landmark gallery's REVIEW MODE (/gallery-landmarks.html): a round served
// by the dev server is listed beside the stage, each stop moves the stage to
// what it names, a verdict and a note carry the item they were given on, and
// the camera can be taken in hand and the stage made fullscreen. The round and
// the verdicts are mocked here: the real endpoints write the checkout.
const { test, expect } = require('./helpers');

const ROUND = {
  round: 't1',
  title: 'Test round',
  items: [
    { id: 't1-mill', title: 'Gulch: the stamp mill', text: 'Moved.', ask: ['Reads?'],
      stops: [{ track: 'gulch', piece: 'set-stamp-mill', view: 'orbit' }, { track: 'gulch', s: 120, lat: 1 }] },
    { id: 't1-race', title: 'Sidewinder: the race', stops: [{ track: 'sidewinder', step: 120, view: 'race', cam: 'free' }] }
  ],
  verdicts: { 't1-race': { decision: 'keep', note: 'fine', at: '2026-11-13T00:00:00.000Z', title: 'Sidewinder: the race' } }
};

const L = (page, fn) => page.evaluate((f) => new Function('L', `return (${f})(L)`)(
  document.getElementById('lm-stage').contentWindow.__landmarks), fn.toString());

test('landmark gallery review: the round, its stops and verdicts', async ({ page }) => {
  await page.route('**/api/review-round', (route) => route.fulfill({ json: ROUND }));
  let verdict = null;
  await page.route('**/api/review-verdict', async (route) => {
    verdict = route.request().postDataJSON();
    await route.fulfill({ json: { verdict: { ...verdict, at: 'now', title: 'x' }, file: 'scratch/review/verdicts-t1.json' } });
  });
  await page.goto('/gallery-landmarks.html');
  await expect(page.locator('#lm-list .kit-row').first()).toBeVisible({ timeout: 30000 });

  // The items, and the verdict already given on one.
  const rows = page.locator('#lm-review > .kit-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Gulch: the stamp mill');
  await expect(rows.nth(1).locator('.kit-row__tris')).toHaveText('Keep');

  // An item opens on its first stop: the track, the piece, the view.
  await rows.nth(0).click();
  await page.waitForFunction(() => {
    const l = document.getElementById('lm-stage').contentWindow.__landmarks;
    return l.trackId() === 'gulch' && l.landmarks()[l.focused()].model === 'set-stamp-mill' && l.mode() === 'orbit';
  }, null, { timeout: 30000 });
  await expect(page.locator('#lm-views [data-view="orbit"]')).toHaveClass(/is-on/);
  await expect(page.locator('.lm-review__stops .ctrl').first()).toHaveClass(/is-on/);
  // A spot on the lap is the driver's view parked there.
  await page.locator('.lm-review__stops .ctrl').nth(1).click();
  expect(await L(page, (l) => l.mode())).toBe('driver');
  await expect(page.locator('#lm-views [data-view="driver"]')).toHaveClass(/is-on/);

  // A question is answered on its own, with no decision...
  await page.locator('.lm-review__answer').first().fill('it does');
  await page.locator('.lm-review__item .ctrl', { hasText: 'Save answers' }).click();
  await expect(rows.nth(0).locator('.kit-row__tris')).toHaveText('Answered');
  expect(verdict).toEqual({ round: 't1', id: 't1-mill', decision: null, note: '', answers: ['it does'] });
  // ...and a verdict posts the item it is given on, with the note and the answers.
  await page.locator('.lm-review__note').fill('taller');
  await page.locator('.lm-review__item [data-decision="rework"]').click();
  await expect(rows.nth(0).locator('.kit-row__tris')).toHaveText('Rework');
  expect(verdict).toEqual({ round: 't1', id: 't1-mill', decision: 'rework', note: 'taller', answers: ['it does'] });
  await expect(page.locator('.lm-review__item')).toContainText('verdicts-t1.json');

  // ] is the next item: a moment of the race, paused, through its cam.
  await page.keyboard.press(']');
  await page.waitForFunction(() => {
    const l = document.getElementById('lm-stage').contentWindow.__landmarks;
    return l.trackId() === 'sidewinder' && l.mode() === 'race' && l.race().step === 120;
  }, null, { timeout: 30000 });
  expect(await L(page, (l) => l.race())).toMatchObject({ paused: true, cam: 'free' });
  // The saved verdict's note is the field's.
  await expect(page.locator('.lm-review__item textarea')).toHaveValue('fine');

  // A note taken now names the item.
  let note = null;
  await page.route('**/api/review-note', async (route) => {
    note = route.request().postDataJSON();
    await route.fulfill({ json: { id: 'test', dir: 'scratch/review' } });
  });
  await page.keyboard.press('n');
  await page.locator('#lm-note-save').click();
  await expect(page.locator('#lm-saved')).toContainText('scratch/review/test.json');
  expect(note.meta.review).toEqual({ round: 't1', item: 't1-race' });
});

// G takes a free camera and gives it back, O orbits the piece and a drag turns
// that orbit (and stops its walk), and F asks for the stage fullscreen. A
// headless browser refuses fullscreen, so what is held is the request.
test('landmark gallery review: the camera in hand, and fullscreen', async ({ page }) => {
  await page.route('**/api/review-round', (route) => route.fulfill({ status: 404, json: { error: 'none' } }));
  await page.goto('/gallery-landmarks.html#view=driver');
  await expect(page.locator('#lm-list .kit-row').first()).toBeVisible({ timeout: 30000 });
  // No round, no panel.
  await expect(page.locator('#lm-review')).toBeHidden();

  await page.keyboard.press('g');
  expect(await L(page, (l) => l.mode())).toBe('free');
  await page.keyboard.press('g');
  expect(await L(page, (l) => l.mode())).toBe('driver');

  await page.keyboard.press('o');
  expect(await L(page, (l) => l.mode())).toBe('orbit');
  const box = await page.locator('#lm-stage').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const eye = () => L(page, (l) => l.poses()[0].eye);
  const before = await eye();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y - 40, { steps: 6 });
  await page.mouse.up();
  const turned = await eye();
  expect(turned).not.toEqual(before);
  await page.waitForTimeout(300);
  expect(await eye()).toEqual(turned);   // held: the walk has stopped

  await page.evaluate(() => {
    window.__asked = [];
    Element.prototype.requestFullscreen = function () { window.__asked.push(this.id); return Promise.resolve(); };
  });
  await page.keyboard.press('f');
  await page.locator('#lm-full').click();
  expect(await page.evaluate(() => window.__asked)).toEqual(['lm-box', 'lm-box']);
});
