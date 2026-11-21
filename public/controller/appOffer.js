// The app offer (the launcher's CONTRACT.md §13): a phone browser is offered the
// Paper Balloon Controller app as a sheet over the name screen, with the browser
// one tap away. Both platforms' buttons lead to an install, so the sheet reads
// the same on both and only its link differs. main.js decides WHEN it shows (a
// fresh browser load, never in the launcher); controller.css lays it out per
// orientation.

const PACKAGE = 'games.paperballoon.controller';
const APP_STORE = 'https://apps.apple.com/app/id6825072879';

const el = (id) => document.getElementById(id);

// 'ios' | 'android' | null. The iOS app is iPhone-only, so an iPad (and every
// desktop) gets no offer.
export function offerPlatform(ua) {
  if (/iPhone/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return null;
}

// The link the offer's button opens. On Android it carries joinUrl (the page's
// own address, which is what the QR encodes) into the app, which joins it like
// a scanned link.
export function offerLink(os, ua, joinUrl) {
  // A Camera scan already opens the App Clip, so an iPhone only lands here
  // another way (another browser, a typed or shared link), where Apple's App
  // Clip link is unreliable. The App Store link works everywhere but carries no
  // room: iOS has no install referrer, so the player scans the code again in
  // the app.
  if (os === 'ios') return APP_STORE;
  // Play carries the room through an install in the referrer.
  const play = 'https://play.google.com/store/apps/details?id=' + PACKAGE
    + '&referrer=' + encodeURIComponent(joinUrl);
  // An installed app gets no referrer, so Chromium gets an intent link that
  // opens it straight on the room and falls back to Play. Firefox and in-app
  // WebViews don't reliably handle intents.
  if (!/Chrome\//.test(ua) || /; wv\)|FBA[NV]|Instagram/.test(ua)) return play;
  // Android splits an intent URL at its LAST '#', so the join URL's own
  // #instance fragment survives in front of #Intent.
  const colon = joinUrl.indexOf(':');
  const scheme = joinUrl.slice(0, colon);
  return 'intent:' + joinUrl.slice(colon + 1)
    + '#Intent;scheme=' + scheme + ';package=' + PACKAGE
    + ';S.browser_fallback_url=' + encodeURIComponent(play) + ';end';
}

// Two stages, as classes on <html>: .app-offer-up is the sheet, and picking the
// browser trades it for .app-offer-nudge, the app as one quiet row under Join
// for the rest of the visit. <html> because portrait needs it there: the sheet
// stands in for the rotate overlay, and resets the small-phone font tiers,
// which are sized for a landscape page.
export function showAppOffer(os, buzz) {
  const href = offerLink(os, navigator.userAgent, location.href);
  for (const link of [el('app-offer-link'), el('app-nudge')]) {
    link.href = href;
    link.onclick = () => buzz('tap');
  }
  el('app-offer-browser').onclick = () => {
    buzz('tap');
    document.documentElement.classList.replace('app-offer-up', 'app-offer-nudge');
  };
  document.documentElement.classList.add('app-offer-up');
}

// Both stages, for good: a room that is gone or full has no app to send anyone to.
export function dropAppOffer() {
  document.documentElement.classList.remove('app-offer-up', 'app-offer-nudge');
}
