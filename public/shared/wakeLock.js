// Screen Wake Lock — keep a screen from sleeping while it matters (the display
// for the whole session, a controller while it's seated in a room). Wraps the
// Screen Wake Lock API; a silent no-op where unsupported or denied (the API
// needs a secure context, and e.g. battery-saver modes can refuse it).
//
// The browser force-releases the lock whenever the tab is hidden (tab switch,
// phone pocketed), so we listen for visibilitychange and take it back on return
// for as long as enable() is in effect.
export function createWakeLock() {
  let lock = null;     // the live WakeLockSentinel (null when not held)
  let wanted = false;  // enable()d and not yet disable()d

  async function request() {
    if (!wanted || lock || !navigator.wakeLock) return;
    if (document.visibilityState !== 'visible') return; // hidden tabs can't hold one
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch (_) { /* refused (power saving etc.) — nothing useful to do */ }
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
