// The pause menu over the race. The display is authoritative over the paused
// state; the phone requests a change and follows the snapshot's `paused`, which
// every snapshot repeats, so only a CHANGE does anything here. While paused the
// overlay covers the screen, so the pause button is disabled.
//
// The phone that asked for the pause gets its choices at once. Every other
// phone, and all of them when the TV paused, gets the frost at once and the
// choices only after PAUSE_ARM_MS: a thumb mid-press on ITEM or BRAKE when
// someone else's pause lands must hit the frost, not Leave game.
//
// Continue and Leave game are everyone's (Leave only where there is a way
// out: a launcher without leave() gets none, as with the close button). The middle button is the host's only
// (the display refuses New game from anyone else, ttp_net_controller_action),
// and while a series runs it is "End cup" behind the intermission's own
// confirm, because abandoning a series loses its points.
import { closeAnyModal, openLeaveCupPopup, closeLeaveCupPopup } from './modals.js';
import { inShell, canLeave } from './launcher.js';

const { MSG } = window;

const PAUSE_ARM_MS = 800;
const PAUSE_ASK_MS = 3000;   // how long our own PAUSE_GAME counts as "we paused"

const el = (id) => document.getElementById(id);

let _ctx = null;
let _shown = false;
let _askedAt = -Infinity;
let _armTimer = 0;

function renderChoices() {
  const btn = el('pause-newgame');
  btn.classList.toggle('hidden', !_ctx.isHost());
  btn.textContent = _ctx.inSeries() ? 'End cup' : 'New game';
}

// ctx: { send(type), buzz(kind), leave(), isHost(), inSeries(), onToggle() }
export function initPauseMenu(ctx) {
  _ctx = ctx;
  el('pause-btn').addEventListener('click', () => {
    _askedAt = performance.now();
    _ctx.buzz('tap');
    _ctx.send(MSG.PAUSE_GAME);
  });
  el('pause-continue').addEventListener('click', () => { _ctx.buzz('tap'); _ctx.send(MSG.RESUME_GAME); });
  el('pause-newgame').addEventListener('click', () => {
    if (!_ctx.isHost()) return;
    _ctx.buzz('tap');
    if (_ctx.inSeries()) openLeaveCupPopup();
    else _ctx.send(MSG.RETURN_TO_LOBBY);
  });
  // Leaving closes this phone's socket: the race stays paused for everyone
  // else, and the seat stays reserved (rejoin QR) until the lobby.
  el('pause-leave').addEventListener('click', () => _ctx.leave());
  el('pause-leave').classList.toggle('hidden', inShell && !canLeave);
}

export function isPauseShown() { return _shown; }

export function setPauseOverlay(on) {
  if (on) renderChoices();   // the host can change while paused
  if (on === _shown) return;
  _shown = on;
  const overlay = el('pause-overlay');
  const arming = on && performance.now() - _askedAt >= PAUSE_ASK_MS;
  _askedAt = -Infinity;
  clearTimeout(_armTimer);
  overlay.classList.toggle('pause--arming', arming);
  if (arming) _armTimer = setTimeout(() => overlay.classList.remove('pause--arming'), PAUSE_ARM_MS);
  // Pause is authoritative and must win the screen: if a popup is open when a
  // pause lands (both sit above the pause overlay), close it so the pause shows.
  // The leave-cup confirm this menu opens goes with the pause.
  if (on) closeAnyModal(); else closeLeaveCupPopup();
  overlay.classList.toggle('hidden', !on);
  el('pause-btn').disabled = on;
  _ctx.onToggle();
}
