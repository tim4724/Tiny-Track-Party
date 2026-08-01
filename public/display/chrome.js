// Three small TV-surface widgets that share nothing with the race but the DOM:
// the auto-hiding race furniture, the fullscreen toggle and the copy toast. Each
// owns its own timer and reads its state off the document, so none of them needs
// anything from the race core — which is why they are here rather than in main.js.
const el = (id) => document.getElementById(id);

// ---- race chrome auto-hide ----
// A running race hides its own furniture after a spell of pointer inactivity:
// the corner buttons (which share the top-right with each cell's place/lap
// readout) fade, and the mouse pointer goes with them — this is a TV surface,
// so a parked arrow is litter on the track. One class on <html> drives both
// (display.css), and any mouse move / tap / key press brings them back.
//
// Armed ONLY while a race is actually running, since a vanished cursor is a
// trap wherever there's something to click: the welcome board, the lobby and
// the results screen never arm it (the pause button is .hidden there — the
// same signal), and pauseRace/resumeRace disarm and re-arm it around the pause
// overlay, whose buttons are the one thing a mouse user MUST be able to hit.
const CHROME_IDLE_MS = 2500;    // starting value — long enough to aim + click after moving
let chromeIdleTimer = 0;

export function revealRaceChrome() {
  // Gated on what's actually ON SCREEN, not on `paused`: the pause button is
  // .hidden off-race, and a visible overlay means a modal wants the mouse —
  // true for a real pause AND for the test harness's `paused` preview, which
  // dresses the overlay without touching the pause state.
  if (el('pause-btn').classList.contains('hidden')) return;
  if (!el('pause-overlay').classList.contains('hidden')) return;
  document.documentElement.classList.remove('chrome-idle');
  clearTimeout(chromeIdleTimer);
  chromeIdleTimer = setTimeout(() => document.documentElement.classList.add('chrome-idle'), CHROME_IDLE_MS);
}

export function holdRaceChrome() {
  clearTimeout(chromeIdleTimer);
  document.documentElement.classList.remove('chrome-idle');
}

// Any pointer or key activity re-arms the idle timer.
for (const ev of ['pointermove', 'pointerdown', 'keydown']) {
  window.addEventListener(ev, revealRaceChrome, { passive: true });
}

// ---- fullscreen ----
// The big screen wants the whole screen: NEW GAME claims it on the session's
// first click (see main.js's bootstrap tail), and this toggle is the way back
// out — and, more usefully, back IN, since entering needs a user gesture and Esc
// / a tab switch can drop it mid-party with no other way to recover. The button
// mirrors the DOCUMENT's state rather than its own clicks: the browser also
// changes it behind our back (Esc, and a denied request never happens at all).
// Hidden where it can't work: fullscreenEnabled is false both with no API at all
// and inside an iframe that wasn't granted the permission (the gallery's preview
// cards), so it covers both without a test-surface special case.
const fullscreenSupported = !!document.fullscreenEnabled;

export function enterFullscreen() {
  if (!fullscreenSupported || document.fullscreenElement) return;
  document.documentElement.requestFullscreen().catch(() => { /* denied/unsupported — play windowed */ });
}

function syncFullscreenBtn() {
  const on = !!document.fullscreenElement;
  el('fullscreen-btn').setAttribute('aria-pressed', on ? 'true' : 'false');
  el('fullscreen-btn').setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
}

el('fullscreen-btn').classList.toggle('hidden', !fullscreenSupported);
el('fullscreen-btn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else enterFullscreen();
});
document.addEventListener('fullscreenchange', syncFullscreenBtn);
syncFullscreenBtn(); // a crash-recovery reload can boot already fullscreen

// ---- copy toast ----
// Brief confirmation toast; auto-hides. Re-trigger restarts the timer.
const TOAST_MS = 1600;
let toastTimer = null;

export function showToast(msg) {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), TOAST_MS);
}

// Copy with a graceful fallback for non-secure contexts where the async
// Clipboard API isn't available (older setups / plain http).
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}
