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
//
// The close button (closeButton.js) is the way out of fullscreen. The auto-enter
// stays on regardless (user call): the next tap anywhere on the page goes
// fullscreen again — any tap but the close button's own.
export function initOrientation({ inShell }) {
  if (inShell) return;                        // the launcher owns the device
  if (new URLSearchParams(location.search).get('scenario')) return; // gallery iframes
  if (!(navigator.maxTouchPoints > 0 || 'ontouchstart' in window)) return;

  let busy = false;

  const keyboardDown = () => new Promise((resolve) => {
    const vv = window.visualViewport;
    const finish = () => { vv.removeEventListener('resize', check); clearTimeout(cap); resolve(); };
    const check = () => { if (!keyboardUp()) finish(); };
    const cap = setTimeout(finish, 1000);
    vv.addEventListener('resize', check);
  });

  const tryFullscreenLandscape = async (e) => {
    // Never on a tap into a text field: the keyboard is about to open, and
    // going fullscreen under it makes Chrome either drop it or lose its pan
    // to the field. Never on the close button: it is the way OUT.
    if (e.target.closest('input, textarea, #close-btn')) return;
    if (busy || document.fullscreenElement) return;
    busy = true;
    try {
      // A tap with the keyboard still up (e.g. Join) waits for it to go first:
      // fullscreen entered under the keyboard keeps the pre-fullscreen height
      // once it closes, a dead band along the bottom. The tap's activation
      // outlives the wait.
      if (keyboardUp()) {
        document.activeElement.blur();
        await keyboardDown();
      }
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

// Is the software keyboard up? It overlays the page
// (interactive-widget=resizes-visual), so it shows as the visual viewport
// shrinking well below the layout one.
export function keyboardUp() {
  const vv = window.visualViewport;
  return !!vv && vv.height < window.innerHeight * 0.8;
}
