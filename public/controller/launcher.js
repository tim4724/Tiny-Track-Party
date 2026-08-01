// The CouchPad launcher shell (CONTRACT.md) — everything that only means
// something when this page is hosted inside the native launcher, in one file so
// the rest of the controller can read as a plain web page.
//
// The launcher (the Android app hosting this page in a WebView, or the iOS app in
// a WKWebView — they behave identically here) appends ?cpv=<version>&cpName=<name>
// to the join URL. Its presence means "running inside the shell", and ALL shell
// behaviour is gated on it, so the same deployed controller keeps working
// untouched in a plain browser. Any cpv value is accepted (forward-compat: an
// unknown higher version is still "shell present").
import { cleanName } from '../shared/names.js';

const params = new URLSearchParams(location.search);

export const inShell = params.has('cpv');
// The launcher's name gate guarantees non-blank <=16 chars; sanitize defensively
// anyway, exactly as the standalone name form does.
export const shellName = inShell ? cleanName(params.get('cpName')) : '';

// Flag the shell on <html> so CSS can drop our own name labels: the launcher
// already shows the player's name in its native top-bar chip, so the in-game
// copies (lobby identity, in-race HUD, how-to-drive demo) are redundant there.
document.documentElement.classList.toggle('cp-shell', inShell);

// Report a TERMINAL session end to the launcher (§3), feature-detected +
// fire-once. Terminal = the session cannot continue (room gone/closed, join
// rejected, seat taken over). The launcher tears down the web view and returns
// home with a message, so the caller must NOT also navigate. Returns true once it
// has signalled (caller stops); false when there is no host to signal (plain
// browser, or a shell without the interface) so the caller falls back to its
// normal in-game handling.
let _sessionEnded = false;
export function endSession(reason) {
  if (!(window.CouchPadHost && window.CouchPadHost.gameEnded)) return false;
  if (_sessionEnded) return true;  // fire-once on our side too; extra calls are ignored anyway
  _sessionEnded = true;
  window.CouchPadHost.gameEnded(reason);
  return true;
}

// Which §3 reason a link state amounts to, or null when the state is recoverable
// (reconnecting, a display that may come back) and stays in-game as our own
// overlay. Pure — the caller decides whether to act on it.
export function terminalReason(state, info) {
  if (state === 'error') {
    return info === 'Room not found' ? 'room_not_found'
      : info === 'Room is full' ? 'game_full' : 'game_ended';
  }
  if (state === 'replaced') return 'replaced';
  if (state === 'lost' || state === 'room_closed') return 'game_ended';
  return null;
}

// Retint the launcher's accent chrome (name chip, spinner, rename sheet) to match
// this player's livery — a live §4 hint. Mutating the meta's content is what the
// launcher's observer watches; a plain browser ignores it. Callers guard on a real
// colour so we never advertise the grey placeholder before livery lands.
export function setAccentColor(color) {
  const meta = document.querySelector('meta[name="cp-accent-color"]');
  if (meta) meta.setAttribute('content', color);
}

// Live rename from the launcher (§2). The game implements it, the launcher calls
// it when the player edits their name in the in-game bar (and re-asserts it on
// every load, belt-and-suspenders with the cpName param). Only meaningful in the
// shell — a plain browser renames via the name screen. The name is NEVER
// persisted (§1): the injected identity must not leak into the game's own storage.
export function installRenameHook(onRename) {
  window.CouchPad = {
    setName(name) {
      if (!inShell) return;
      onRename(cleanName(name) || 'Racer');
    }
  };
}
