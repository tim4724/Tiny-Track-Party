// @ts-check
// A fresh load in a phone browser leads with the Paper Balloon app (appOffer.js,
// launcher contract §13); the browser stays one tap away. tests/app-offer.test.js
// covers the links themselves. The rest of the suite runs a desktop user agent,
// which gets no offer.
const { test, expect, openDisplay, visible } = require('./helpers');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const LANDSCAPE = { width: 844, height: 390 };
const GONE = 'That race has ended. Scan a fresh QR code on the big screen.';
const PORTRAIT = { width: 390, height: 844 };

async function openPhone(browser, path, userAgent, viewport) {
  const context = await browser.newContext({ userAgent, viewport });
  await context.addInitScript(() => { try { localStorage.setItem('tinytrack_seen_help', '1'); } catch (_) {} });
  const phone = await context.newPage();
  await phone.goto(path);
  return phone;
}

test('landscape: an iPhone is offered the App Store, then joins in the browser', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const phone = await openPhone(browser, `/${roomCode}`, IPHONE, LANDSCAPE);

  await expect(phone.locator('#app-offer')).toBeVisible();
  await expect(phone.locator('#name-input')).toBeHidden();
  const link = new URL(await phone.locator('#app-offer-link').getAttribute('href') || '');
  expect(link.host).toBe('apps.apple.com');

  // Picking the browser leaves the app as one row under Join, on the same link.
  await phone.click('#app-offer-browser');
  await expect(phone.locator('#app-offer')).toBeHidden();
  await expect(phone.locator('#app-nudge')).toBeVisible();
  expect(await phone.locator('#app-nudge').getAttribute('href')).toBe(link.href);
  await phone.fill('#name-input', 'Ann');
  await phone.click('#join-btn');
  await phone.waitForSelector(visible('#lobby'));
});

test('portrait: the sheet stands in for the rotate overlay until the browser is picked', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const phone = await openPhone(browser, `/${roomCode}`, IPHONE, PORTRAIT);

  await expect(phone.locator('#app-offer')).toBeVisible();
  await expect(phone.locator('#rotate')).toBeHidden();
  await phone.click('#app-offer-browser');
  await expect(phone.locator('#rotate')).toBeVisible();
  await phone.setViewportSize(LANDSCAPE);
  await expect(phone.locator('#rotate')).toBeHidden();
  await expect(phone.locator('#name-input')).toBeVisible();
});

test('Chrome on Android gets an intent link to the app', async ({ page, browser }) => {
  const roomCode = await openDisplay(page);
  const phone = await openPhone(browser, `/${roomCode}`, ANDROID_CHROME, LANDSCAPE);

  await expect(phone.locator('#app-offer')).toBeVisible();
  const href = await phone.locator('#app-offer-link').getAttribute('href') || '';
  expect(href.startsWith('intent://')).toBe(true);
  expect(href).toContain(';package=games.paperballoon.controller;');
});

test('a gone room drops both stages of the offer and says why', async ({ browser }) => {
  const phone = await openPhone(browser, '/ZZZZ', IPHONE, LANDSCAPE);
  await expect(phone.locator('#name-status')).toHaveText(GONE);
  await expect(phone.locator('#app-offer')).toBeHidden();
  // The browser picked before the room check answered: the join's own refusal
  // is what has to drop the nudge.
  await phone.evaluate(() => document.documentElement.classList.add('app-offer-nudge'));
  await expect(phone.locator('#app-nudge')).toBeVisible();
  await phone.fill('#name-input', 'Ann');
  await phone.click('#join-btn');
  await expect(phone.locator('#app-nudge')).toBeHidden();
});
