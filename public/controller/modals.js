// The controller's two popups and the plumbing they share.
//
// They are deliberately SEPARATE popups with separate triggers: Settings holds
// the steering-mode switch plus the animated how-to-drive demo (auto-shows once
// per device, doubling as the tutorial), while the motion popup is an actionable
// recovery path for a blocked sensor. Collapsing them would mean either nagging
// a working phone with a fix it doesn't need, or burying the fix inside a
// settings card a returning player never re-opens.
//
// Ordering rules live here rather than at the call sites, because they only make
// sense against each other: the motion popup wins the lobby-entry beat (the two
// must never stack), motion sits above settings for Escape, and a pause closes
// both.
import { motionHelpCopy } from './ui.js';
import { helpSeen, markHelpSeen } from './prefs.js';

const el = (id) => document.getElementById(id);

let _screens = null;
let _tilt = null;
let _buzz = () => {};
let _playerName = () => 'Racer';
let _getInputMode = () => 'tilt';
let _setInputMode = () => {};
let _isHost = () => false;
let _getSoundOn = () => true;
let _setSoundOn = () => {};
let _onModalToggle = () => {};

// True in gallery/scenario mode — auto-popups stay shut there (the harness opens
// the one it's previewing; with no relay, no room snapshot ever arrives anyway).
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

// ---- Settings popup ----
// Auto-shows ONCE per device on first lobby entry (it teaches the controls); the
// gear buttons (lobby + game) reopen it. _settingsReturnFocus is the element
// focused before opening, so closing returns focus to it.
let _settingsReturnFocus = null;

const settingsOpen = () => !el('settings-overlay').classList.contains('hidden');

// Sync the card to the CURRENT input mode: the seg's checked side and the
// .is-buttons class that flips the demo phone + captions between modes.
// On a device with no motion sensor (main.js forced buttons at startup) the
// Tilt row is disabled outright and its sticker says why — a pickable-looking
// Tilt would only lead into a recovery popup with no recovery.
function refreshSettingsCard() {
  const buttons = _getInputMode() === 'buttons';
  el('settings-card').classList.toggle('is-buttons', buttons);
  el('input-tilt').setAttribute('aria-checked', String(!buttons));
  el('input-buttons').setAttribute('aria-checked', String(buttons));
  const noTilt = _tilt.motionState === 'unsupported';
  el('input-tilt').disabled = noTilt;
  el('input-tilt').querySelector('.mode-card__badge').textContent =
    noTilt ? 'Not available' : 'Recommended';
  // The TV section — the DISPLAY's controls, host only (the display's verdict
  // re-checks, so hiding it here is UX, not the gate). The Sound switch renders
  // the snapshot's soundOn.
  el('tv-seg').classList.toggle('hidden', !_isHost());
  el('sound-toggle').setAttribute('aria-checked', String(_getSoundOn()));
}

// The snapshot moved something the open card renders — host handover, or the
// display's own mute button flipping soundOn. No-op while the card is closed
// (openSettings re-syncs anyway).
export function refreshSettingsState() {
  if (settingsOpen()) refreshSettingsCard();
}

function openSettings() {
  _settingsReturnFocus = document.activeElement;
  setDemoNames(_playerName());   // both demo phones read as "your phone" (livery via --car)
  refreshSettingsCard();
  el('settings-overlay').classList.remove('hidden');
  setBackgroundInert(true);
  // keyboard-operable + announced; the trap keeps Tab inside. preventScroll
  // because the seed is the card's LAST control: on a screen too short for the
  // card, focusing it scrolled the card to the bottom, so Settings opened with
  // its own title already off the top.
  el('settings-done').focus({ preventScroll: true });
  _onModalToggle();
}

function closeSettings() {
  el('settings-overlay').classList.add('hidden');
  if (!motionOpen()) setBackgroundInert(false);   // un-inert BEFORE restoring focus
  restoreFocus(_settingsReturnFocus); _settingsReturnFocus = null;
  _onModalToggle();
}

// Both mode cards carry a demo phone, so the name is a class, not an id.
function setDemoNames(name) {
  for (const n of document.querySelectorAll('.phone-name')) n.textContent = name;
}

// A live launcher rename (§2) — or a snapshot catching up on the engine's
// placeholder — while the demo phones are on screen.
export function refreshHelpName(name) {
  if (settingsOpen()) setDemoNames(name);
}

function maybeAutoShowSettings() {
  if (inScenario() || helpSeen() || settingsOpen()) return;
  openSettings();    // show first, THEN stamp — a throw before it shows can't burn the once
  markHelpSeen();
}

// ---- Motion-blocked popup ----
// Surfaces when the tilt sensor is blocked (iOS denied), with the live recovery
// path. Auto-shows once per page load on lobby entry while blocked (no nagging
// on every lobby return) — and only in TILT mode: button steering needs no
// sensor, so a buttons phone is never nagged. A page that cannot get tilt at all
// ('unsupported') never qualifies: whoever resolved it also put the phone on
// buttons, and the settings card's Tilt row says why — there is nothing a popup
// could offer, which is why it has no face for that state. Copy
// + action live in ui.js (motionHelpCopy) so they can't drift from the gallery.
let _motionAlertShown = false;
let _motionReturnFocus = null;

const motionOpen = () => !el('motion-overlay').classList.contains('hidden');
const motionBlocked = () => _tilt.motionState === 'denied';

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
  el('motion-done').focus({ preventScroll: true });
  _onModalToggle();
}

function closeMotionPopup() {
  el('motion-overlay').classList.add('hidden');
  if (!settingsOpen()) setBackgroundInert(false);
  restoreFocus(_motionReturnFocus); _motionReturnFocus = null;
  _onModalToggle();
}

function maybeShowMotionAlert() {
  if (inScenario() || _motionAlertShown || motionOpen() || !motionBlocked()) return;
  _motionAlertShown = true;
  openMotionPopup();
}

// ---- the rules that only make sense against each other ----

// On reaching the lobby: if tilt is the mode and the sensor is blocked, the
// actionable motion popup wins the beat (so the two never stack); otherwise
// teach the controls once. A blocked player still gets the intro later — once
// motion is sorted, this runs again with the seen flag still unset.
export function onEnterLobby() {
  if (inScenario()) return;
  if (_getInputMode() === 'tilt' && motionBlocked()) maybeShowMotionAlert();
  else maybeAutoShowSettings();
}

// Pause is authoritative and must win the screen; leaving the room must not
// strand a popup over the name screen. Both want the same thing: whatever is up,
// close it.
export function closeAnyModal() {
  if (settingsOpen()) closeSettings();
  if (motionOpen()) closeMotionPopup();
}

// Whether any popup is up — the shell's system-back sync reads this (an open
// dialog is what back should close, even mid-race).
export function anyModalOpen() { return settingsOpen() || motionOpen(); }

// Close the topmost popup, report whether one was there — the shell's
// window.CouchPad.back handler (motion sits above settings, so it goes first).
export function closeTopModal() {
  if (motionOpen()) { closeMotionPopup(); return true; }
  if (settingsOpen()) { closeSettings(); return true; }
  return false;
}

export function initModals({ screens, tilt, buzz, playerName, getInputMode, setInputMode,
                             isHost, getSoundOn, setSoundOn, onModalToggle }) {
  _screens = screens; _tilt = tilt; _buzz = buzz; _playerName = playerName;
  if (getInputMode) _getInputMode = getInputMode;
  if (setInputMode) _setInputMode = setInputMode;
  if (isHost) _isHost = isHost;
  if (getSoundOn) _getSoundOn = getSoundOn;
  if (setSoundOn) _setSoundOn = setSoundOn;
  if (onModalToggle) _onModalToggle = onModalToggle;

  el('settings-btn').addEventListener('click', () => { _buzz(15); openSettings(); });
  el('settings-btn-game').addEventListener('click', () => { _buzz(15); openSettings(); });
  el('settings-done').addEventListener('click', () => { _buzz(15); closeSettings(); });
  el('settings-overlay').addEventListener('keydown', (e) => trapTab(el('settings-overlay'), e));

  // The steering-mode seg. Picking Tilt (re-)requests motion permission INSIDE
  // this tap (the iOS gesture rule); if the sensor stays blocked, surface the
  // recovery popup right away rather than letting the player discover it
  // mid-race. Picking Buttons needs nothing from the platform.
  el('input-buttons').addEventListener('click', () => {
    if (_getInputMode() === 'buttons') return;
    _buzz(15);
    _setInputMode('buttons');
    refreshSettingsCard();
  });
  el('input-tilt').addEventListener('click', async () => {
    if (_getInputMode() === 'tilt') return;
    _buzz(15);
    _setInputMode('tilt');
    refreshSettingsCard();
    if (_tilt.motionState !== 'granted') {
      await _tilt.enableMotion();
      // Trying is the only way to prove a sensor absent on a browser that can't
      // be asked, so the Tilt row can be live at click time and dead by now.
      // Put the phone back on buttons and let the card say why.
      if (_tilt.motionState === 'unsupported') _setInputMode('buttons');
      refreshSettingsCard();
      if (motionBlocked()) openMotionPopup();
    }
  });

  // The Sound switch — optimistic like every lobby control: send, render, and
  // let the next LOBBY_UPDATE (the display echoes soundOn) be the truth.
  el('sound-toggle').addEventListener('click', () => {
    _buzz(15);
    _setSoundOn(!_getSoundOn());
    refreshSettingsCard();
  });

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
    // Allowed, but the sensor delivers nothing. There is no recovery to offer
    // (the dead-end "tilt isn't available" face was removed on purpose), so
    // close and fall back rather than loop the player through Allow again.
    if (_tilt.motionState === 'unsupported') {
      _setInputMode('buttons');
      closeMotionPopup();
      return;
    }
    if (_tilt.motionState === 'granted') {
      el('motion-title').textContent = 'Motion access on';
      el('motion-status').textContent = 'Tilt to steer is ready.';
      btn.classList.add('hidden');
      el('motion-fix').classList.add('hidden');
    } else {
      refreshMotionPopup();   // now 'denied' → button flips to "Reload & ask again"
    }
  });

  // Escape closes whichever modal is up (motion sits above settings — close it first).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (motionOpen()) { e.preventDefault(); e.stopPropagation(); closeMotionPopup(); }
    else if (settingsOpen()) { e.preventDefault(); e.stopPropagation(); closeSettings(); }
  });
}
