// --- control schemes (EXPLORATION) ---
// Four ways to drive, cycled by the in-race #ctrl-btn: the input source (the tilt
// sensor, or LEFT/ITEM/RIGHT buttons where holding both steer buttons brakes) ×
// how the phone is held. The page is always served PORTRAIT (the Couch Games shell
// locks the WebView), so "landscape" is emulated — controller.css rotates the whole
// drive surface 90° and the player turns the phone; TiltInput is told about that
// rotation so the steering reference follows the picture. Deliberately no settings
// screen: the button is the control AND the readout, and the pick is remembered so
// a reload keeps testing the same one.
const el = (id) => document.getElementById(id);

let _tilt = null;
let _buzz = () => {};
let _gameVisible = () => false;
let _releaseControls = () => {};
let _setNoiseless = () => {};

const CTRL_KEY = 'tinytrack_ctrl_scheme';
const CTRL_SCHEMES = [
  { id: 'tilt-portrait',  src: 'TILT', rot: 'P', tilt: true,  land: false, hint: 'Tilt to steer' },
  { id: 'tilt-landscape', src: 'TILT', rot: 'L', tilt: true,  land: true,  hint: 'Hold it sideways, tilt to steer' },
  { id: 'btn-portrait',   src: 'BTNS', rot: 'P', tilt: false, land: false, hint: 'Hold LEFT + RIGHT to brake' },
  { id: 'btn-landscape',  src: 'BTNS', rot: 'L', tilt: false, land: true,  hint: 'Hold LEFT + RIGHT to brake' }
];
let ctrlScheme = Math.max(0, CTRL_SCHEMES.findIndex((s) => {
  try { return s.id === localStorage.getItem(CTRL_KEY); } catch (_) { return false; }
}));

export function applyScheme() {
  const s = CTRL_SCHEMES[ctrlScheme];
  const root = document.documentElement;
  // Rotate only while the drive surface is actually up: the lobby and the results
  // board have no scheme button, so a sideways one would be a trap.
  root.classList.toggle('ctrl-land', s.land && _gameVisible());
  root.classList.toggle('ctrl-buttons', !s.tilt);
  el('ctrl-btn-src').textContent = s.src;
  el('ctrl-btn-rot').textContent = s.rot;
  el('steer-label').textContent = s.hint;
  // The "tilt is off" chip is only true trouble in a tilt scheme — a button
  // scheme drives fine with the sensor blocked. (It lives inside the drive HUD, so
  // it's out of sight off the game screen without a second condition here.)
  el('motion-tip').classList.toggle('hidden', !(s.tilt && _tilt.motionState !== 'granted'));
  _tilt.setScheme({ tilt: s.tilt, extraAngle: s.land ? 90 : 0 });   // no-op when unchanged
  // Buttons carry no sensor noise, so the send gate's noise dead-bands come off
  // with them — every ramp step is deliberate news (see InputGate.setNoiseless).
  _setNoiseless(!s.tilt);
}

// `gameVisible` and `releaseControls` are injected rather than imported: the drive
// surface owns the buttons and imports applyScheme, so reaching back for them
// directly would close the loop between the two modules.
export function initControlScheme({ tilt, buzz, gameVisible, releaseControls, setNoiseless }) {
  _tilt = tilt; _buzz = buzz; _gameVisible = gameVisible; _releaseControls = releaseControls;
  _setNoiseless = setNoiseless;

  el('ctrl-btn').addEventListener('click', () => {
    _buzz(15);
    // Nothing may stay held across a swap: the button that was down might be the one
    // the new scheme hides, and its input would stick forever.
    _releaseControls();
    ctrlScheme = (ctrlScheme + 1) % CTRL_SCHEMES.length;
    try { localStorage.setItem(CTRL_KEY, CTRL_SCHEMES[ctrlScheme].id); } catch (_) {}
    applyScheme();
  });
}
