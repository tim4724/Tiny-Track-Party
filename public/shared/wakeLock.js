// Screen Wake Lock — keep a screen from sleeping while it matters (the display
// while a party exists, a controller while it's seated in a room). Wraps the
// Screen Wake Lock API; a silent no-op where unsupported or denied (the API
// needs a secure context, and e.g. battery-saver modes can refuse it).
//
// The browser force-releases the lock whenever the tab is hidden (tab switch,
// phone pocketed), so we listen for visibilitychange and take it back on return
// for as long as enable() is in effect.
//
// The grant is async and enable()/disable() can come in any order around it
// (the display calls one or the other on every roster render): one request at
// a time, and a grant that lands after a disable() is handed straight back, or
// a sentinel nothing holds keeps the screen on for good.
export function createWakeLock() {
  let lock = null;         // the live WakeLockSentinel (null when not held)
  let wanted = false;      // enable()d and not yet disable()d
  let requesting = false;  // a request() is awaiting its grant

  async function request() {
    if (!wanted || lock || requesting || !navigator.wakeLock) return;
    if (document.visibilityState !== 'visible') return; // hidden tabs can't hold one
    requesting = true;
    try {
      const granted = await navigator.wakeLock.request('screen');
      if (!wanted) { granted.release().catch(() => {}); return; }
      lock = granted;
      granted.addEventListener('release', () => { if (lock === granted) lock = null; });
    } catch (_) { /* refused (power saving etc.) — nothing useful to do */ }
    finally { requesting = false; }
  }
  document.addEventListener('visibilitychange', request);

  return {
    enable() { wanted = true; request(); },   // idempotent — safe on every (re)join
    disable() {
      wanted = false;
      if (lock) { lock.release().catch(() => {}); lock = null; }
    },
    get active() { return !!lock; }           // debug/test readout only
  };
}
