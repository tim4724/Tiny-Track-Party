// The drive surface: everything that turns the phone into a controller once a
// race is live — the steer bar, BRAKE, ACTION, and the held-item badge that gates
// ACTION. Grouped because they share one idea: the player's eyes are on the big
// screen, not here, so every control confirms itself by FEEL (a buzz, a rumble)
// rather than by anything they would have to look down to read.
//
// The item's IDENTITY is shown on the main display (flashy roulette there); the
// phone stays a clean driving surface. The only controller-side cue is the USE
// button lighting up when you're holding something, plus a light buzz on pickup.
import { applyScheme } from './controlScheme.js';

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
  applyScheme();   // owns the motion tip (a blocked sensor is only a problem for the tilt schemes)
  const loop = () => {
    fill.style.transform = `translateX(${_tilt.state.steer * 50}%)`;
    steerRaf = requestAnimationFrame(loop);
  };
  loop();
}

export function stopDriving() {
  _tilt.stop();
  if (steerRaf) cancelAnimationFrame(steerRaf);
  steerRaf = null;
  releaseControls();   // a race can end mid-hold
}

// Drop every held control back to rest: the input, the motor, and the pressed
// look. Called at race end and on a scheme swap — after a swap the button that
// was down may be the one the new scheme hides, and its input would stick forever.
export function releaseControls() {
  _pressBrake(false);
  pressSteerBtn(-1, false);
  pressSteerBtn(1, false);
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

// BRAKE — held = brake at the fixed rate, released = release. A continuous
// rumble runs while it's held: the player's eyes-free confirmation they're
// braking (they're watching the car on the main display, not the phone).
function _pressBrake(on) {
  on ? _haptics.startLoop() : _haptics.stopLoop();
  _tilt.pressBrake(on);
  el('brake-btn').classList.toggle('held', on);
}

// LEFT / RIGHT steer buttons — the button schemes' whole steering, and their brake:
// holding BOTH cancels the steer to centre and brakes, so the same continuous
// rumble the BRAKE button runs confirms it eyes-free.
//
// A steer press itself buzzes NOTHING, deliberately. It used to get a light tick,
// and that tick was what made braking feel like TWO vibrations: fingers never land
// together, so the first button ticked and the second started the rumble — one
// gesture, two separate things to feel. Steering is also the wrong shape for a
// tick: it is HELD, not tapped (a buzz per corner entry is a rattle), and it is
// already confirmed by the car turning on the screen the player is watching. The
// brake is the one thing here with no visual tell of its own, so it keeps the
// rumble and now owns the whole channel.
//
// Input goes out BEFORE the haptic call on purpose: navigator.vibrate reaches the
// OS vibrator service and is not guaranteed to return instantly, and nothing may
// sit between a press and the wire.
const steerBtnFor = (dir) => el(dir < 0 ? 'left-btn' : 'right-btn');
function pressSteerBtn(dir, on) {
  steerBtnFor(dir).classList.toggle('held', on);
  const was = _tilt.bothSteerHeld;
  _tilt.pressSteer(dir, on);
  const now = _tilt.bothSteerHeld;
  if (now !== was) { if (now) _haptics.startLoop(); else _haptics.stopLoop(); }
}

export function initDriveSurface({ tilt, buzz, haptics }) {
  _tilt = tilt; _buzz = buzz; _haptics = haptics;

  const brakeBtn = el('brake-btn');
  brakeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); _pressBrake(true); });
  brakeBtn.addEventListener('pointerup', () => _pressBrake(false));
  brakeBtn.addEventListener('pointercancel', () => _pressBrake(false));
  brakeBtn.addEventListener('pointerleave', () => _pressBrake(false));

  for (const dir of [-1, 1]) {
    const btn = steerBtnFor(dir);
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); pressSteerBtn(dir, true); });
    btn.addEventListener('pointerup', () => pressSteerBtn(dir, false));
    btn.addEventListener('pointercancel', () => pressSteerBtn(dir, false));
    btn.addEventListener('pointerleave', () => pressSteerBtn(dir, false));
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
