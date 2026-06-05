// Shared car-thumbnail component. The lobby car picker (controller) and the
// display lobby both show pre-baked renders of each Kenney car model instead of
// running Three.js on the phone — plain image assets, so no WebGL, no importmap,
// and it works on every mobile browser (old ones included). Assets are generated
// offline by rendering each GLB (front-3/4 hero + a full spin), matching the
// in-race toy-plastic look:
//   <model>.png        — front-3/4 hero still (universal PNG)
//   <model>.strip.png  — horizontal sprite strip of the turntable (SPIN_FRAMES
//                        frames). Animated by stepping background-position.
//
// Spin sync: ALL spinning cars are driven by ONE shared requestAnimationFrame
// clock, so they read the same frame index every tick and rotate in lockstep
// (the display shows several cars pointing the same way, not a random jumble).
const BASE = '/assets/toycar/thumbs/';

export const carStill = (model) => BASE + model + '.png';
export const carStrip = (model) => BASE + model + '.strip.png';

// Turntable: keep these in sync with the baked strips and the .carthumb__spin
// background-size in theme.css (background-size width = SPIN_FRAMES * 100%).
export const SPIN_FRAMES = 24;
const SPIN_FPS = 8; // 24 frames / 8 fps = 3s per full turn

// Lobby/picker render mode. Defaults to 'spin' (rotates the focused car — the
// player's current pick on the controller, each joined car on the display);
// 'still' shows the calm hero everywhere. Order of precedence:
//   1. explicit ?carview=still|spin  (gallery / testing / opt-out)
//   2. prefers-reduced-motion: reduce → 'still'  (accessibility wins)
//   3. default → 'spin'
export function carView() {
  let param = null;
  try { param = new URLSearchParams(location.search).get('carview'); } catch (_) { /* no location */ }
  if (param === 'still' || param === 'spin') return param;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'still';
  } catch (_) { /* no matchMedia (very old browser) → fall through to default */ }
  return 'spin';
}

// ---- shared spin clock ----------------------------------------------------
// Every registered overlay element gets the SAME background-position each tick,
// so all spinning cars are perfectly synchronized regardless of when they were
// added. Disconnected elements drop out automatically; the loop idles when none
// remain. Falls back to a static hero (frame 0) where rAF is unavailable.
const _spins = new Set();
let _raf = 0;
let _start = 0;
function _tick(t) {
  if (!_start) _start = t;
  const frame = Math.floor(((t - _start) / 1000) * SPIN_FPS) % SPIN_FRAMES;
  const posX = (SPIN_FRAMES > 1 ? (frame * 100) / (SPIN_FRAMES - 1) : 0).toFixed(3) + '%';
  for (const el of _spins) {
    if (!el.isConnected) { _spins.delete(el); continue; }
    el.style.backgroundPositionX = posX;
  }
  _raf = _spins.size ? requestAnimationFrame(_tick) : 0;
}
function registerSpin(el) {
  if (typeof requestAnimationFrame !== 'function') return; // old browser → static hero
  _spins.add(el);
  if (!_raf) _raf = requestAnimationFrame(_tick);
}

// Build a car thumbnail node: a square box showing the still hero, plus (in spin
// mode) a synchronized turntable overlay that fades in once its strip loads — so
// there's never a blank frame and the static hero never ghosts behind the spin.
// The caller sizes it (the box is width:100% of its container).
export function carThumbNode(model, { spin = false } = {}) {
  const box = document.createElement('div');
  box.className = 'carthumb';

  const still = document.createElement('img');
  still.className = 'carthumb__still';
  still.alt = ''; still.draggable = false; still.decoding = 'async';
  still.src = carStill(model);
  box.appendChild(still);

  if (spin && carView() === 'spin') {
    const overlay = document.createElement('div');
    overlay.className = 'carthumb__spin';
    box.appendChild(overlay);
    const url = carStrip(model);
    const pre = new Image();
    pre.onload = () => {
      if (!overlay.isConnected) return;            // tile was replaced before load
      overlay.style.backgroundImage = `url("${url}")`;
      still.style.opacity = '0';                   // hand off to the spin (frame 0 == hero)
      registerSpin(overlay);
    };
    pre.src = url;
  }
  return box;
}
