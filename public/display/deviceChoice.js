// The display URL opened on a phone-sized screen (see #device-choice in
// index.html + display.css): most likely someone followed the wrong link while
// trying to JOIN a game, so don't open a room until they commit to running the
// big screen here. On big screens (and test/solo surfaces, which dismiss
// up front) we mark it dismissed immediately, so resizing the window
// mid-session can never surface the chooser over a live lobby or race.
const el = (id) => document.getElementById(id);

export function dismissDeviceChoice() {
  document.documentElement.classList.add('device-choice-dismissed');
}

// Run `onChosen` (the room's start) as soon as the big screen is committed to —
// immediately where the chooser doesn't show, otherwise on the button or on the
// window growing past the breakpoint.
export function startWhenDeviceChosen(onChosen) {
  const choice = el('device-choice');
  if (!choice || getComputedStyle(choice).display === 'none') {
    dismissDeviceChoice();
    onChosen();
    return;
  }
  window.__deviceChoicePending = true; // E2E hook: the boot took the deferred path
  let chosen = false;
  const proceed = () => {
    if (chosen) return;
    chosen = true;
    window.__deviceChoicePending = false;
    window.removeEventListener('resize', onResize);
    dismissDeviceChoice();
    onChosen();
  };
  // The chooser's visibility is pure CSS (the display.css media query): if the
  // window grows past the trigger — a small desktop window getting maximised —
  // the overlay vanishes on its own, so treat that as choosing the big screen
  // or the room would never open. Reading the computed style on resize keeps
  // the breakpoint defined in exactly one place (the CSS).
  const onResize = () => { if (getComputedStyle(choice).display === 'none') proceed(); };
  el('device-continue').addEventListener('click', proceed);
  window.addEventListener('resize', onResize);
}
