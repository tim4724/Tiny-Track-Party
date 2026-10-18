// The close button (X), top-right on every screen but the race: alone in the
// corner on the name and results screens (#close-btn), the last key of the
// settings pill in the lobby (#lobby-close). In the CouchPad launcher it is the
// player's way out (CONTRACT §3: iOS has no system back, Android's is off while
// driving), so it shows everywhere the launcher offers leave(). In a race the
// pause button holds that corner instead and the way out is the pause menu's
// "Leave game": one stray tap must not quit a race. In a plain browser it backs
// out of the room and leaves fullscreen; on the name screen there is no room to
// leave, so there it shows only while fullscreen, to leave that. What a tap
// DOES is the caller's (main.js exitRoom).
import { inShell, canLeave } from './launcher.js';

let _screen = null;

function sync() {
  const allowed = inShell ? canLeave : (_screen !== 'name' || !!document.fullscreenElement);
  document.getElementById('close-btn').classList.toggle('hidden',
    !allowed || _screen === 'lobby' || _screen === 'game');
  document.getElementById('lobby-close').classList.toggle('hidden', !allowed);
}

// Called on every screen change — by main.js, and by the gallery harness so its
// previews show the button exactly where a player sees it.
export function syncCloseButton(screen) {
  _screen = screen;
  sync();
}

export function initCloseButton(onClose) {
  document.addEventListener('fullscreenchange', sync);
  for (const id of ['close-btn', 'lobby-close']) document.getElementById(id).addEventListener('click', onClose);
}
