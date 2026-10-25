// The display URL opened on a phone-sized screen (see #device-choice in
// index.html + display.css): the game's landing page for anyone arriving from a
// link, and the fork for someone who followed the wrong one while trying to
// JOIN a game, so don't open a room until they commit to running the big screen
// here. On big screens (and test/solo surfaces, which dismiss up front) we mark
// it dismissed immediately, so resizing the window mid-session can never
// surface the chooser over a live lobby or race.
import { copyText } from './chrome.js';

const el = (id) => document.getElementById(id);

export function dismissDeviceChoice() {
  document.documentElement.classList.add('device-choice-dismissed');
}

// The landing's own controls. Wired when this module loads, not from
// startWhenDeviceChosen: boot calls that only once the engine has loaded, and
// the landing is on screen from the first paint, like NEW GAME and TRAILER.
function initLanding(choice) {
  // The big button sends this page to a big screen: the phone's share sheet
  // where there is one, otherwise the link onto the clipboard. It names the
  // address it was opened at, so a preview shares the preview.
  el('device-share-host').textContent = location.host;
  el('device-share').addEventListener('click', async () => {
    const payload = { title: 'Tiny Track Party', text: 'Race your friends! Everyone steers with their phone.', url: location.origin };
    if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
      // A refusal other than the person cancelling falls through to the clipboard.
      try { await navigator.share(payload); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    if (await copyText(location.origin)) el('device-share-sub').textContent = 'Link copied. Open it on your big screen';
  });
  // iOS Safari applies :active on a tap only where something listens for
  // touches, so without this the presses (the play disc, the share button)
  // would never show on an iPhone.
  choice.addEventListener('touchstart', () => {}, { passive: true });
}
initLanding(el('device-choice'));

// Resolves as soon as the big screen is committed to — immediately where the
// chooser doesn't show, otherwise on the button or on the window growing past
// the breakpoint. main.js awaits it BEFORE the engine boot, not just before the
// room's start: a phone that only reads the landing (which is most phone visits)
// never downloads or compiles the engine and never stands up WebGL, so the page
// it is reading stays responsive and its picture isn't starved of bandwidth.
// The welcome board behind already answers NEW GAME before the engine is up.
export function whenDeviceChosen() {
  const choice = el('device-choice');
  if (!choice || getComputedStyle(choice).display === 'none') {
    dismissDeviceChoice();
    return Promise.resolve();
  }
  window.__deviceChoicePending = true; // E2E hook: the boot took the deferred path
  return new Promise((resolve) => {
    let chosen = false;
    const proceed = () => {
      if (chosen) return;
      chosen = true;
      window.__deviceChoicePending = false;
      window.removeEventListener('resize', onResize);
      dismissDeviceChoice();
      resolve();
    };
    // The chooser's visibility is pure CSS (the display.css media query): if the
    // window grows past the trigger — a small desktop window getting maximised —
    // the overlay vanishes on its own, so treat that as choosing the big screen
    // or the room would never open. Reading the computed style on resize keeps
    // the breakpoint defined in exactly one place (the CSS).
    const onResize = () => { if (getComputedStyle(choice).display === 'none') proceed(); };
    el('device-continue').addEventListener('click', proceed);
    window.addEventListener('resize', onResize);
  });
}
