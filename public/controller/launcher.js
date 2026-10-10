// The CouchPad launcher shell (CONTRACT.md) — everything that only means
// something when this page is hosted inside the native launcher (the Android
// app's WebView or the iOS app's WKWebView), in one file so the rest of the
// controller can read as a plain web page. This is the one module that reads
// window.CouchPadHost. The bridge exists only inside the launcher, so its
// PRESENCE is the shell gate, and every touchpoint on it is feature-detected on
// top of that — the same deployed controller keeps working untouched in a plain
// browser.
//
// `cp*` is the launcher's RESERVED query namespace — this game mints no param
// starting with `cp`, and ignores any it doesn't know, since they may be
// addressed to the launcher rather than to us (`cpp`, which the display puts on
// the join URL to name itself, is exactly that).
import { cleanName } from '../shared/names.js';

const host = window.CouchPadHost;

export const inShell = !!host;

// §1: the player's name, shared across games and always set — the launcher makes
// one up on first run, so the shell joins without a name screen. Sanitized
// defensively anyway, exactly as the name screen's own field is. '' means a
// launcher that cannot define the property (an Android WebView too old for
// document-start scripts, which gets neither `name` nor editName()), and that
// one gets the name screen.
export const shellName = inShell && typeof host.name === 'string' ? cleanName(host.name) : '';

// §2: a rename opens the LAUNCHER's name sheet, which owns the name's rules. The
// Promise resolves to the saved name, or null when the player dismisses it.
export const canEditName = inShell && typeof host.editName === 'function';
export async function editName() {
  return cleanName(await host.editName()) || null;
}

// §3: the player's own exit. The launcher closes the web view, which ends the
// relay socket with it, so the caller neither cleans up nor navigates. canLeave
// gates every way out the shell shows (the close button, "Exit to start").
export const canLeave = !!(host && typeof host.leave === 'function');
export function leave() {
  host.leave();
}

// Report a TERMINAL session end to the launcher (§3), feature-detected +
// fire-once. Terminal = the session cannot continue (room gone/closed, join
// rejected, seat taken over). The launcher tears down the web view and returns
// home with a message, so the caller must NOT also navigate. Returns true once it
// has signalled (caller stops); false when there is no host to signal (plain
// browser, or a shell without the interface) so the caller falls back to its
// normal in-game handling.
let _sessionEnded = false;
export function endSession(reason) {
  if (!(host && host.gameEnded)) return false;
  if (_sessionEnded) return true;  // fire-once on our side too; extra calls are ignored anyway
  _sessionEnded = true;
  host.gameEnded(reason);
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

// System back (§9). Armed, a back gesture reaches window.CouchPad.back (and the
// screen edges go to the system); disarmed, edge swipes stay gameplay input and
// the close button is the only exit. Deduped on transitions — the contract
// expects state changes, not chatter — and feature-detected like every other
// touchpoint.
let _backArmed = null;
export function armSystemBack(want) {
  if (!(host && typeof host.enableSystemBack === 'function')) return;
  want = !!want;
  if (want === _backArmed) return;
  _backArmed = want;
  host.enableSystemBack(want);
}

// The launcher calls this once per gesture, only while armed. Return true =
// consumed (a dialog closed), anything else = the launcher leaves the game —
// which is exactly what a lobby/results back should do.
export function installBackHook(onBack) {
  window.CouchPad = window.CouchPad || {};
  window.CouchPad.back = () => onBack() === true;
}
