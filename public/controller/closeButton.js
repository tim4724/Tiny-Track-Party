// The close button (X), top-left on every screen. In the CouchPad launcher it
// is the player's only way out (CONTRACT §3: iOS has no system back, Android's
// is off while driving), so it shows everywhere the launcher offers leave(). In
// a plain browser it backs out of the room and leaves fullscreen; on the name
// screen there is no room to leave, so there it shows only while fullscreen,
// to leave that. What a tap DOES is the caller's (main.js exitRoom).
import { inShell, canLeave } from './launcher.js';

let _screen = null;

function sync() {
  const show = inShell ? canLeave : (_screen !== 'name' || !!document.fullscreenElement);
  document.getElementById('close-btn').classList.toggle('hidden', !show);
}

// Called on every screen change — by main.js, and by the gallery harness so its
// previews show the button exactly where a player sees it.
export function syncCloseButton(screen) {
  _screen = screen;
  sync();
}

export function initCloseButton(onClose) {
  document.addEventListener('fullscreenchange', sync);
  document.getElementById('close-btn').addEventListener('click', onClose);
}
