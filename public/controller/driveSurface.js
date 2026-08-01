// The drive surface: everything that turns the phone into a controller once a
// race is live — the steer bar, BRAKE, ACTION, and the held-item badge that gates
// ACTION. Grouped because they share one idea: the player's eyes are on the big
// screen, not here, so every control confirms itself by FEEL (a buzz, a rumble)
// rather than by anything they would have to look down to read.
//
// The item's IDENTITY is shown on the main display (flashy roulette there); the
// phone stays a clean driving surface. The only controller-side cue is the USE
// button lighting up when you're holding something, plus a light buzz on pickup.
const el = (id) => document.getElementById(id);

let _tilt = null;
let _buzz = () => {};
let _haptics = null;

// --- steering ---
let steerRaf = null;

export function startDriving(playerName) {
  el('hud-name').textContent = playerName;   // who you are, top-left (mirrors the display cell)
  if (steerRaf) return; // already driving (may have begun during the countdown)
  _tilt.start();
  const fill = el('steer-fill');
  el('motion-tip').classList.toggle('hidden', _tilt.motionState === 'granted');
  const loop = () => {
    fill.style.transform = `translateX(${_tilt.state.steer * 50}%)`;
    steerRaf = requestAnimationFrame(loop);
  };
  loop();
}

export function stopDriving() {
  _tilt.stop();
  _haptics.stopLoop(); // never leave the motor humming if BRAKE was held at race end
  if (steerRaf) cancelAnimationFrame(steerRaf);
  steerRaf = null;
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

export function initDriveSurface({ tilt, buzz, haptics }) {
  _tilt = tilt; _buzz = buzz; _haptics = haptics;

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
