// The controller's two popups and the plumbing they share.
//
// They are deliberately SEPARATE popups with separate triggers: How-to-Drive is
// purely instructional (teaches tilt/brake/item, auto-shows once per device), while
// the motion popup is an actionable recovery path for a blocked sensor. Collapsing
// them would mean either nagging a working phone with a fix it doesn't need, or
// burying the fix inside an intro a returning player never re-opens.
//
// Ordering rules live here rather than at the call sites, because they only make
// sense against each other: the motion popup wins the lobby-entry beat (the two
// must never stack), motion sits above help for Escape, and a pause closes both.
import { motionHelpCopy } from './ui.js';
import { helpSeen, markHelpSeen } from './prefs.js';

const el = (id) => document.getElementById(id);

let _screens = null;
let _tilt = null;
let _buzz = () => {};
let _playerName = () => 'Racer';

// True in gallery/scenario mode — auto-popups stay shut there (the harness opens
// the one it's previewing; a real WELCOME never fires anyway).
const inScenario = () => !!new URLSearchParams(location.search).get('scenario');

// While a modal is up, mark the screens behind it inert so a screen reader's
// virtual cursor (and any stray Tab) can't reach the lobby/HUD underneath —
// aria-modal + the keyboard trap only cover sighted keyboard users. inert is
// ignored where unsupported, so this degrades to the trap alone.
function setBackgroundInert(on) {
  for (const k of Object.keys(_screens)) _screens[k].toggleAttribute('inert', on);
}

// Minimal focus trap: keep Tab/Shift+Tab cycling within the open card's VISIBLE
// focusables (a hidden button is in the DOM but offsetParent null — exclude it, or
// Tab lands on something invisible).
function trapTab(overlay, e) {
  if (e.key !== 'Tab') return;
  const f = [...overlay.querySelectorAll('button:not([disabled])')].filter((b) => b.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

const restoreFocus = (node) => { if (node && node.focus) node.focus(); };

// ---- How-to-Drive popup ----
// Auto-shows ONCE per device on first lobby entry; the "?" buttons (lobby + game)
// reopen it. _helpReturnFocus is the element focused before opening, so closing
// returns focus to it (the "?" that opened it).
let _helpReturnFocus = null;

const helpOpen = () => !el('help-overlay').classList.contains('hidden');

function openHelp() {
  _helpReturnFocus = document.activeElement;
  el('phone-name').textContent = _playerName();   // demo phone reads as "your phone" (livery via --car)
  el('help-overlay').classList.remove('hidden');
  setBackgroundInert(true);
  el('help-done').focus();   // keyboard-operable + announced; the trap keeps Tab inside
}

function closeHelp() {
  el('help-overlay').classList.add('hidden');
  if (!motionOpen()) setBackgroundInert(false);   // un-inert BEFORE restoring focus
  restoreFocus(_helpReturnFocus); _helpReturnFocus = null;
}

// A live launcher rename (§2) while the demo phone is on screen.
export function refreshHelpName(name) {
  if (helpOpen()) el('phone-name').textContent = name;
}

function maybeAutoShowHelp() {
  if (inScenario() || helpSeen() || helpOpen()) return;
  openHelp();        // show first, THEN stamp — a throw before it shows can't burn the once
  markHelpSeen();
}

// ---- Motion-blocked popup ----
// Surfaces when the tilt sensor is blocked (iOS denied) or absent (unsupported),
// with the live recovery path. Auto-shows once per page load on lobby entry while
// blocked (no nagging on every lobby return). Copy + action live in ui.js
// (motionHelpCopy) so they can't drift from the gallery.
let _motionAlertShown = false;
let _motionReturnFocus = null;

const motionOpen = () => !el('motion-overlay').classList.contains('hidden');
const motionBlocked = () => { const s = _tilt.motionState; return s === 'denied' || s === 'unsupported'; };

// Populate the popup's title/status/Allow/fix from the resolved state.
function refreshMotionPopup() {
  const copy = motionHelpCopy(_tilt.motionState);
  if (!copy.show) return;          // granted — popup shouldn't be up; guard anyway
  el('motion-title').textContent = copy.title;
  el('motion-status').textContent = copy.status;
  const allow = el('motion-allow');
  allow.classList.toggle('hidden', !copy.allow);
  allow.disabled = false; allow.textContent = copy.allowText;
  const fix = el('motion-fix');
  if (copy.fix) { fix.classList.remove('hidden'); fix.innerHTML = copy.fix; }
  else fix.classList.add('hidden');
}

function openMotionPopup() {
  _motionReturnFocus = document.activeElement;
  refreshMotionPopup();
  el('motion-overlay').classList.remove('hidden');
  setBackgroundInert(true);
  el('motion-done').focus();
}

function closeMotionPopup() {
  el('motion-overlay').classList.add('hidden');
  if (!helpOpen()) setBackgroundInert(false);
  restoreFocus(_motionReturnFocus); _motionReturnFocus = null;
}

function maybeShowMotionAlert() {
  if (inScenario() || _motionAlertShown || motionOpen() || !motionBlocked()) return;
  _motionAlertShown = true;
  openMotionPopup();
}

// ---- the rules that only make sense against each other ----

// On reaching the lobby: if tilt is blocked, the actionable motion popup wins the
// beat (so the two never stack); otherwise teach the controls once. A blocked
// player still gets the controls intro later — once motion is sorted, this runs
// again with the help flag still unseen.
export function onEnterLobby() {
  if (inScenario()) return;
  if (motionBlocked()) maybeShowMotionAlert();
  else maybeAutoShowHelp();
}

// Pause is authoritative and must win the screen; leaving the room must not
// strand a popup over the name screen. Both want the same thing: whatever is up,
// close it.
export function closeAnyModal() {
  if (helpOpen()) closeHelp();
  if (motionOpen()) closeMotionPopup();
}

export function initModals({ screens, tilt, buzz, playerName }) {
  _screens = screens; _tilt = tilt; _buzz = buzz; _playerName = playerName;

  el('help-btn').addEventListener('click', () => { _buzz(15); openHelp(); });
  el('help-btn-game').addEventListener('click', () => { _buzz(15); openHelp(); });
  el('help-done').addEventListener('click', () => { _buzz(15); closeHelp(); });
  el('help-overlay').addEventListener('keydown', (e) => trapTab(el('help-overlay'), e));

  el('motion-done').addEventListener('click', () => { _buzz(15); closeMotionPopup(); });
  el('motion-overlay').addEventListener('keydown', (e) => trapTab(el('motion-overlay'), e));
  // The in-race "tilt is off" chip reopens the recovery popup (its only fix path,
  // since players have no keyboard fallback).
  el('motion-tip').addEventListener('click', () => { _buzz(15); openMotionPopup(); });

  // Primary recovery button — what it DOES depends on the resolved state (see
  // motionHelpCopy's `action`). Once iOS has denied, re-calling requestPermission()
  // resolves 'denied' silently (no prompt), so 'denied' RELOADS instead: the next
  // Join re-raises the prompt (name is restored from localStorage). 'unknown'
  // (gallery / pre-prompt) is the only state where a fresh request can still
  // prompt — there we (re-)call enableMotion() within this gesture and confirm a
  // grant in place.
  el('motion-allow').addEventListener('click', async () => {
    _buzz(15);
    if (motionHelpCopy(_tilt.motionState).action === 'reload') { location.reload(); return; }
    const btn = el('motion-allow');
    btn.disabled = true; btn.textContent = 'Asking…';
    await _tilt.enableMotion();
    if (_tilt.motionState === 'granted') {
      el('motion-title').textContent = 'Motion access on';
      el('motion-status').textContent = 'Tilt to steer is ready.';
      btn.classList.add('hidden');
      el('motion-fix').classList.add('hidden');
    } else {
      refreshMotionPopup();   // now 'denied' → button flips to "Reload & ask again"
    }
  });

  // Escape closes whichever modal is up (motion sits above help — close it first).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (motionOpen()) { e.preventDefault(); e.stopPropagation(); closeMotionPopup(); }
    else if (helpOpen()) { e.preventDefault(); e.stopPropagation(); closeHelp(); }
  });
}
