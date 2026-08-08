// Landscape enforcement for the PLAIN BROWSER. The controller is landscape-only:
// in the CouchPad shell the launcher rotates and pins the device for us
// (shellOrient.js, contract §10), but a browser can only be ASKED — fullscreen
// plus an orientation lock, both of which need a user gesture. So this module
// piggybacks on gestures the player already makes (any tap, from the name screen
// on) and tries again whenever fullscreen was lost, which is as close to
// "whenever possible" as the platform allows. Everything is best-effort and
// silent: iOS Safari has no element fullscreen and no lock at all — there the
// portrait overlay in index.html (pure CSS on the orientation media query) is
// what turns the phone sideways.
//
// The touch gate keeps this off desktops (a dev tabbing around must not have
// the page fling itself fullscreen) and out of the headless E2E browsers.
export function initOrientation({ inShell }) {
  if (inShell) return;                        // the launcher owns the device
  if (new URLSearchParams(location.search).get('scenario')) return; // gallery iframes
  if (!(navigator.maxTouchPoints > 0 || 'ontouchstart' in window)) return;

  let busy = false;
  const tryFullscreenLandscape = async () => {
    if (busy || document.fullscreenElement) return;
    busy = true;
    try {
      // Fullscreen first: Chrome/Android only honours an orientation lock from
      // fullscreen. Each step may throw (iOS: no requestFullscreen on elements;
      // desktop: lock unsupported) — swallow and let the CSS overlay do the work.
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch (_) { /* best effort — the rotate overlay covers the rest */ }
    busy = false;
  };

  // Capture-phase, so the attempt rides the same gesture as whatever button the
  // player was tapping (join, ready, a car tile …) without any handler changes.
  window.addEventListener('pointerup', tryFullscreenLandscape, { capture: true, passive: true });
}
