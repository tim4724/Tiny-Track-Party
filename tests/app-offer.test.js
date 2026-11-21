'use strict';
// The links behind the controller's app offer (public/controller/appOffer.js).
// Each Android link must hand the launcher the join URL intact: it joins
// whatever arrives.
const test = require('node:test');
const assert = require('node:assert/strict');

let offerPlatform, offerLink;
test.before(async () => {
  ({ offerPlatform, offerLink } = await import('../public/controller/appOffer.js'));
});

const JOIN = 'https://tinytrack.paperballoon.games/A3KX9p?pbp=web#fra-1';
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  chrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  webview: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 Instagram 350.0',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const PLAY = 'https://play.google.com/store/apps/details?id=games.paperballoon.controller&referrer='
  + encodeURIComponent(JOIN);

test('only iPhones and Android phones get an offer', () => {
  assert.equal(offerPlatform(UA.iphone), 'ios');
  assert.equal(offerPlatform(UA.chrome), 'android');
  assert.equal(offerPlatform(UA.firefox), 'android');
  assert.equal(offerPlatform(UA.ipad), null);
  assert.equal(offerPlatform(UA.desktop), null);
});

test('iPhone: the App Store page', () => {
  assert.equal(offerLink('ios', UA.iphone, JOIN), 'https://apps.apple.com/app/id6825072879');
});

test('Chromium on Android: an intent link that falls back to the Play referrer link', () => {
  for (const ua of [UA.chrome, UA.samsung]) {
    const link = offerLink('android', ua, JOIN);
    // Android's Intent.parseUri splits at the LAST '#': everything before it,
    // the join URL's own query and fragment included, is the intent's data.
    const cut = link.lastIndexOf('#');
    assert.equal(link.slice(0, cut), 'intent://tinytrack.paperballoon.games/A3KX9p?pbp=web#fra-1');
    const fields = link.slice(cut + 1).split(';');
    assert.equal(fields[0], 'Intent');
    assert.equal(fields[fields.length - 1], 'end');
    assert.ok(fields.includes('scheme=https'));
    assert.ok(fields.includes('package=games.paperballoon.controller'));
    // Android decodes each value once (Uri.decode).
    const fallback = fields.find((f) => f.startsWith('S.browser_fallback_url='));
    assert.equal(decodeURIComponent(fallback.slice('S.browser_fallback_url='.length)), PLAY);
  }
});

test('Firefox and in-app WebViews on Android: the plain Play referrer link', () => {
  assert.equal(offerLink('android', UA.firefox, JOIN), PLAY);
  assert.equal(offerLink('android', UA.webview, JOIN), PLAY);
  assert.equal(new URL(PLAY).searchParams.get('referrer'), JOIN);
});
