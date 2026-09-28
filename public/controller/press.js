// Press paint for the page's tap targets.
//
// The pressed look is CSS `:active`, and on a touch screen that is not a
// promise. WebKit withholds it while it is still deciding whether a touch is a
// scroll — inside .carpick, a scroll container, that is most taps — and drops
// it again on the smallest drift, so on iOS and in Safari the buttons that are
// only tapped read as dead. With -webkit-tap-highlight-color cleared (see
// controller.css) there is no platform highlight left to stand in for it
// either.
//
// The drive controls already answered this with a class driven by pointer
// events; this is the same answer delegated once for everything else. It is
// paint only — no control here learns about its own presses from this file.
//
// Not the drive controls themselves: their `.held` is part of their INPUT
// state (a brake released by pointerleave has to un-paint with the release,
// not with the finger lifting), and one owner per element is the point.

const HELD = 'held';
let _held = null;

function release() {
  if (!_held) return;
  _held.classList.remove(HELD);
  _held = null;
}

export function initPressPaint() {
  // All three in CAPTURE: a handler that stops propagation on its own button
  // must not be able to swallow the down (no paint at all) or the up (paint
  // stuck on). pointercancel is the SCROLL signal — the browser takes the
  // pointer the moment a touch that started on a tile turns out to be a pan,
  // so a scrolled strip never leaves a tile painted down under the finger.
  document.addEventListener('pointerdown', (e) => {
    release();
    const btn = e.target.closest('button:not(:disabled)');
    if (!btn || btn.closest('.drive-controls')) return;
    _held = btn;
    btn.classList.add(HELD);
  }, true);
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
}
