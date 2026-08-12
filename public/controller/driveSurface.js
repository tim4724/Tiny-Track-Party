// The drive surface: everything that turns the phone into a controller once a
// race is live — the steer bar, the mode's controls (tilt: BRAKE + ACTION;
// buttons: ‹ / ACTION / ›), and the held-item badge that gates ACTION. Grouped
// because they share one idea: the player's eyes are on the big screen, not
// here, so every control confirms itself by FEEL (a buzz, a rumble) rather than
// by anything they would have to look down to read.
//
// The item's IDENTITY is shown on the main display (flashy roulette there); the
// phone stays a clean driving surface. The only controller-side cue is the USE
// button lighting up when you're holding something, plus a light buzz on pickup.
const el = (id) => document.getElementById(id);

let _tilt = null;
let _buzz = () => {};
let _haptics = null;
let _mode = 'tilt';

// --- steering ---
let steerRaf = null;

// The motion chip only means something while TILT is the steering mode — a
// buttons phone never needs the sensor.
function refreshMotionTip() {
  const show = steerRaf && _mode === 'tilt' && _tilt.motionState !== 'granted';
  el('motion-tip').classList.toggle('hidden', !show);
}

export function startDriving(playerName) {
  el('hud-name').textContent = playerName;   // who you are, top-left (mirrors the display cell)
  if (steerRaf) return; // already driving (may have begun during the countdown)
  _tilt.start();
  const fill = el('steer-fill');
  steerRaf = requestAnimationFrame(function loop() {
    fill.style.transform = `translateX(${_tilt.state.steer * 50}%)`;
    steerRaf = requestAnimationFrame(loop);
  });
  refreshMotionTip();
}

export function stopDriving() {
  _tilt.stop();
  _haptics.stopLoop(); // never leave the motor humming if BRAKE was held at race end
  if (steerRaf) cancelAnimationFrame(steerRaf);
  steerRaf = null;
  releaseSteerButtons();
}

// --- input mode ---
// Applies the steering mode everywhere it shows: the TiltInput signal path and
// the #game mode class the CSS keys the controls off. Called at boot with the
// stored preference and live from the Settings seg.
export function setInputMode(mode) {
  _mode = mode === 'buttons' ? 'buttons' : 'tilt';
  _tilt.setMode(_mode);
  const game = el('game');
  game.classList.toggle('mode-tilt', _mode === 'tilt');
  game.classList.toggle('mode-buttons', _mode === 'buttons');
  releaseSteerButtons();
  refreshMotionTip();
}

// --- held item / ACTION gating ---
// Names map to .is-<id> livery classes in controller.css.
const ITEM_LABEL = { boost: 'BOOST', banana: 'BANANA', rocket: 'ROCKET', monster: 'MONSTER' };
let _heldItem = undefined;

export function setHeldItem(item) {
  if (item === _heldItem) return;            // only react on a change
  _heldItem = item;
  const actionBtn = el('action-btn');
  actionBtn.disabled = !item;
  _tilt.setActionEnabled(!!item);            // gate BOTH the button and the keyboard ACTION
  actionBtn.setAttribute('aria-label', item ? `Use ${ITEM_LABEL[item] || item}` : 'Use item');
  if (item) _buzz(20);                       // eyes-free "you picked something up" (look at the TV for what)
}

// Leaving the room: force the next setHeldItem(null) through the change guard, so
// the button really does go dark for the next race.
export function resetHeldItem() {
  _heldItem = undefined;
  setHeldItem(null);
}

// --- the ‹ › steer buttons (buttons mode) ---
// Held → full lock that side; BOTH held is the brake chord, confirmed by the
// same continuous rumble the tilt-mode BRAKE runs (one motor, one meaning).
const _steerHeld = { left: false, right: false };

function pressSteer(side, on) {
  if (_steerHeld[side] === on) return;
  _steerHeld[side] = on;
  el(side === 'left' ? 'steer-left' : 'steer-right').classList.toggle('held', on);
  _tilt.pressSteer(side, on);
  const braking = _steerHeld.left && _steerHeld.right;
  if (braking) _haptics.startLoop(); else _haptics.stopLoop();
  if (on && !braking) _buzz(12);             // light tick on a steer press; the chord gets the rumble
}

function releaseSteerButtons() {
  pressSteer('left', false);
  pressSteer('right', false);
}

export function initDriveSurface({ tilt, buzz, haptics }) {
  _tilt = tilt; _buzz = buzz; _haptics = haptics;

  // A held control must not trigger Android's long-press gesture: its context
  // menu never shows over these buttons, but the OS haptic for it still fires —
  // a phantom second buzz ~500ms into every hold, over our own press tick.
  document.querySelector('.drive-controls').addEventListener('contextmenu', (e) => e.preventDefault());

  // BRAKE — held = brake at the fixed rate, released = release. A continuous
  // rumble runs while it's held: the player's eyes-free confirmation they're
  // braking (they're watching the car on the main display, not the phone).
  const brakeBtn = el('brake-btn');
  const pressBrake = (on) => {
    on ? _haptics.startLoop() : _haptics.stopLoop();
    _tilt.pressBrake(on);
    brakeBtn.classList.toggle('held', on);
  };
  brakeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); pressBrake(true); });
  brakeBtn.addEventListener('pointerup', () => pressBrake(false));
  brakeBtn.addEventListener('pointercancel', () => pressBrake(false));
  brakeBtn.addEventListener('pointerleave', () => pressBrake(false));

  // ‹ › — hold to steer, both for the brake chord. pointerleave releases too:
  // a thumb sliding off the sticker must not leave the car locked hard over.
  for (const side of ['left', 'right']) {
    const btn = el(side === 'left' ? 'steer-left' : 'steer-right');
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); pressSteer(side, true); });
    btn.addEventListener('pointerup', () => pressSteer(side, false));
    btn.addEventListener('pointercancel', () => pressSteer(side, false));
    btn.addEventListener('pointerleave', () => pressSteer(side, false));
  }

  // ACTION (use item) — one tap = one use. Bumps the wrapping use-counter the next
  // CONTROL frame carries; disabled (and ignored) while the slot is empty.
  const actionBtn = el('action-btn');
  actionBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (actionBtn.disabled) return;
    _tilt.pressAction(); _buzz(20); actionBtn.classList.add('held');
  });
  const releaseAction = () => actionBtn.classList.remove('held');
  actionBtn.addEventListener('pointerup', releaseAction);
  actionBtn.addEventListener('pointercancel', releaseAction);
  actionBtn.addEventListener('pointerleave', releaseAction);
}
